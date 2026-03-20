// agent-messages v21: Fix check — direct messages never missed + own messages filtered
// POST { action: "send" | "check" | "respond" | "register" | "who-online" | "mark-read" | "thread"
//                | "update-status" | "get-protocol" | "update-protocol" | "ack-protocol" }
// All entries stored in design_space table (category = "agent_message") — every message is searchable knowledge
// Work orders are messages with message_type = "work-order" and status in metadata
// Signal strength HIGHLIGHTS relevance but NEVER hides messages

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getEmbedding(text: string): Promise<number[] | null> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.data[0].embedding;
  } catch {
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const { action } = body;

    // ==================== SEND ====================
    // Unified: all message types including work orders
    // message_type: notification | question | work-order | handoff | broadcast | answer | claim | status-update
    if (action === "send") {
      const {
        content, from_agent, from_platform = "claude-code", to_agent,
        project, message_type = "notification", title,
        priority = "normal", topics = [], components = [], attachments = [],
        status, // For work-orders: ready, in-progress, done, blocked
      } = body;

      if (!content || !from_agent) {
        return jsonResponse({ error: "content and from_agent are required" }, 400);
      }

      const thread_id = crypto.randomUUID();
      const embeddingText = title ? `${title}\n${content}` : content;
      const embedding = await getEmbedding(embeddingText);

      const metadata: any = {
        from_agent,
        from_platform,
        to_agent: to_agent || null,
        message_type,
        priority,
        attachments,
        read_by: [],
      };

      // Work order metadata
      if (message_type === "work-order") {
        metadata.title = title || null;
        metadata.status = status || "ready";
        metadata.claimed_by = null;
        metadata.claimed_at = null;
        metadata.completed_at = null;
      }

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          project,
          topics,
          components,
          embedding,
          thread_id,
          metadata,
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ message, thread_id });
    }

    // ==================== CHECK ====================
    // Returns ALL unread messages — nothing hidden based on agent identity
    // Signal strength HIGHLIGHTS relevance but every message is visible
    if (action === "check") {
      const { agent_id, project, limit = 50 } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      // Derive base agent name if session-scoped (e.g. "freya-2567" → "freya")
      const sessionMatch = agent_id.match(/^(.+)-(\d{4})$/);
      const baseAgentId = sessionMatch ? sessionMatch[1] : null;
      const directIds = baseAgentId ? [agent_id, baseAgentId] : [agent_id];

      // Phase 1: Direct messages to this agent (no limit — never miss a direct message)
      const { data: directMessages, error: directError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .in("metadata->>to_agent", directIds)
        .order("created_at", { ascending: false });

      if (directError) throw directError;

      // Phase 2: All other recent messages (broadcasts + messages to others)
      const { data: otherMessages, error: otherError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .not("metadata->>to_agent", "in", `(${directIds.map(id => `"${id}"`).join(",")})`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (otherError) throw otherError;

      // Merge and deduplicate
      const seen = new Set<string>();
      const allMessages = [...(directMessages || []), ...(otherMessages || [])].filter((m: any) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Filter: remove already-read and own messages (both broadcasts and directed)
      const filtered = allMessages.filter((m: any) => {
        const readBy = m.metadata?.read_by || [];
        if (readBy.includes(agent_id)) return false;
        if (baseAgentId && readBy.includes(baseAgentId)) return false;
        // Filter ALL own messages — broadcasts AND directed
        const fromAgent = m.metadata?.from_agent;
        if (fromAgent === agent_id) return false;
        if (baseAgentId && fromAgent === baseAgentId) return false;
        return true;
      });

      // Compute signal strength — for HIGHLIGHTING, not filtering
      const scored = filtered.map((m: any) => {
        const toAgent = m.metadata?.to_agent;
        const msgProject = m.project;
        const agentMatch = toAgent && directIds.includes(toAgent);
        const projectMatch = project && msgProject === project;

        let signal: string;
        if (agentMatch && projectMatch) {
          signal = "strong";
        } else if (agentMatch) {
          signal = "medium";
        } else if (projectMatch) {
          signal = "weak";
        } else {
          signal = "available";
        }

        return { ...m, signal };
      });

      // Sort by signal strength, then recency
      const signalOrder: Record<string, number> = { strong: 0, medium: 1, weak: 2, available: 3 };
      scored.sort((a: any, b: any) => {
        const diff = signalOrder[a.signal] - signalOrder[b.signal];
        if (diff !== 0) return diff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      return jsonResponse({
        messages: scored,
        unread_count: scored.length,
      });
    }

    // ==================== RESPOND ====================
    if (action === "respond") {
      const {
        message_id, thread_id: provided_thread_id,
        content, from_agent, from_platform = "claude-code",
        message_type = "answer", attachments = [], project,
      } = body;

      if (!content || !from_agent) {
        return jsonResponse({ error: "content and from_agent are required" }, 400);
      }

      let thread_id = provided_thread_id;
      let to_agent: string | null = null;

      if (message_id && !thread_id) {
        const { data: original } = await supabase
          .from("design_space")
          .select("thread_id, metadata")
          .eq("id", message_id)
          .single();

        if (original) {
          thread_id = original.thread_id;
          to_agent = original.metadata?.from_agent || null;
        }
      }

      if (!thread_id) {
        return jsonResponse({ error: "Could not resolve thread_id" }, 400);
      }

      const embedding = await getEmbedding(content);

      let resolvedProject = project;
      if (!resolvedProject && message_id) {
        const { data: orig } = await supabase
          .from("design_space")
          .select("project")
          .eq("id", message_id)
          .single();
        if (orig) resolvedProject = orig.project;
      }

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          project: resolvedProject || null,
          embedding,
          thread_id,
          metadata: {
            from_agent,
            from_platform,
            to_agent,
            message_type,
            attachments,
            read_by: [],
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ message });
    }

    // ==================== UPDATE-STATUS ====================
    // Update status on any message (replaces claim-task + update-task)
    // Works on work-orders but also any message that has status metadata
    if (action === "update-status") {
      const { message_id, agent_id, status: newStatus, result } = body;

      if (!message_id || !agent_id) {
        return jsonResponse({ error: "message_id and agent_id are required" }, 400);
      }

      const { data: existing } = await supabase
        .from("design_space")
        .select("metadata")
        .eq("id", message_id)
        .single();

      if (!existing) {
        return jsonResponse({ error: "Message not found" }, 404);
      }

      const updates: any = { ...existing.metadata };
      if (newStatus) {
        updates.status = newStatus;
        if (newStatus === "in-progress" && !updates.claimed_by) {
          updates.claimed_by = agent_id;
          updates.claimed_at = new Date().toISOString();
        }
        if (newStatus === "done") {
          updates.completed_at = new Date().toISOString();
        }
      }
      if (result) updates.result = result;

      const { data: message, error } = await supabase
        .from("design_space")
        .update({ metadata: updates })
        .eq("id", message_id)
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ message });
    }

    // ==================== REGISTER ====================
    if (action === "register") {
      const {
        agent_id, agent_name, model, platform = "claude-code",
        framework, repo, working_on, workspace,
        capabilities = [], tools_available = [],
        context_window, status = "online", pronouns,
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const alreadySuffixed = /^.+-\d{4}$/.test(agent_id);
      const sessionCode = alreadySuffixed ? null : String(Math.floor(1000 + Math.random() * 9000));
      const effectiveAgentId = alreadySuffixed ? agent_id : `${agent_id}-${sessionCode}`;
      const baseAgentId = alreadySuffixed ? agent_id.replace(/-\d{4}$/, "") : agent_id;
      const code = sessionCode || effectiveAgentId.split("-").pop();

      const { data: agent, error } = await supabase
        .from("agent_presence")
        .upsert({
          agent_id: effectiveAgentId,
          agent_name: agent_name || agent_id,
          model,
          platform,
          framework,
          repo,
          working_on,
          workspace,
          capabilities,
          tools_available,
          context_window,
          status,
          pronouns,
          session_id: crypto.randomUUID(),
          session_start: new Date().toISOString(),
          last_heartbeat: new Date().toISOString(),
          metadata: { base_agent_id: baseAgentId, session_code: code },
        }, { onConflict: "agent_id" })
        .select()
        .single();

      if (error) throw error;

      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: onlineAgents } = await supabase
        .from("agent_presence")
        .select("agent_id, agent_name, pronouns, repo, working_on, last_heartbeat")
        .eq("status", "online")
        .gte("last_heartbeat", cutoff)
        .neq("agent_id", effectiveAgentId);

      // Auto-include protocol if agent hasn't read the current version
      let instructions = null;
      const { data: protocol } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "protocol")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (protocol) {
        const readBy = protocol.metadata?.read_by || [];
        const hasRead = readBy.includes(effectiveAgentId) || (baseAgentId && readBy.includes(baseAgentId));
        if (!hasRead) {
          instructions = {
            content: protocol.content,
            version: protocol.metadata?.version || 1,
            updated_at: protocol.updated_at || protocol.created_at,
          };
          // Auto-acknowledge: mark as read for this agent
          if (!readBy.includes(effectiveAgentId)) {
            readBy.push(effectiveAgentId);
            await supabase
              .from("design_space")
              .update({ metadata: { ...protocol.metadata, read_by: readBy } })
              .eq("id", protocol.id);
          }
        }
      }

      return jsonResponse({
        agent,
        session_id: effectiveAgentId,
        session_code: code,
        online: onlineAgents || [],
        instructions,
      });
    }

    // ==================== WHO-ONLINE ====================
    if (action === "who-online") {
      const { repo, capability } = body;

      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      let query = supabase
        .from("agent_presence")
        .select("*")
        .eq("status", "online")
        .gte("last_heartbeat", cutoff);

      if (repo) {
        query = query.eq("repo", repo);
      }

      const { data: agents, error } = await query;
      if (error) throw error;

      let filtered = agents || [];
      if (capability) {
        filtered = filtered.filter((a: any) =>
          (a.capabilities || []).includes(capability)
        );
      }

      return jsonResponse({
        agents: filtered,
        online_count: filtered.length,
      });
    }

    // ==================== MARK-READ ====================
    if (action === "mark-read") {
      const { message_ids, agent_id } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }
      if (!message_ids || !Array.isArray(message_ids)) {
        return jsonResponse({ error: "message_ids array is required" }, 400);
      }

      for (const id of message_ids) {
        const { data: existing } = await supabase
          .from("design_space")
          .select("metadata")
          .eq("id", id)
          .single();

        if (existing) {
          const readBy = existing.metadata?.read_by || [];
          if (!readBy.includes(agent_id)) {
            readBy.push(agent_id);
          }
          await supabase
            .from("design_space")
            .update({
              metadata: { ...existing.metadata, read_by: readBy },
            })
            .eq("id", id);
        }
      }

      return jsonResponse({ marked: message_ids.length, agent_id });
    }

    // ==================== THREAD ====================
    if (action === "thread") {
      const { thread_id } = body;

      if (!thread_id) {
        return jsonResponse({ error: "thread_id is required" }, 400);
      }

      const { data: messages, error } = await supabase
        .from("design_space")
        .select("*")
        .eq("thread_id", thread_id)
        .order("created_at", { ascending: true });

      if (error) throw error;

      return jsonResponse({
        thread_id,
        messages: messages || [],
        count: (messages || []).length,
      });
    }

    // ==================== GET-PROTOCOL ====================
    if (action === "get-protocol") {
      const { agent_id } = body;

      const { data: protocol, error } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "protocol")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116") throw error;

      if (!protocol) {
        return jsonResponse({ protocol: null, version: 0 });
      }

      const readBy = protocol.metadata?.read_by || [];
      const isNew = agent_id ? !readBy.includes(agent_id) : true;

      return jsonResponse({
        protocol: protocol.content,
        version: protocol.metadata?.version || 1,
        is_new: isNew,
        updated_at: protocol.updated_at || protocol.created_at,
      });
    }

    // ==================== UPDATE-PROTOCOL ====================
    if (action === "update-protocol") {
      const { content, from_agent, version } = body;

      if (!content || !version) {
        return jsonResponse({ error: "content and version are required" }, 400);
      }

      await supabase
        .from("design_space")
        .delete()
        .eq("category", "protocol");

      const { data: protocol, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "protocol",
          metadata: {
            version,
            from_agent: from_agent || "system",
            read_by: [],
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ protocol, version });
    }

    // ==================== ACK-PROTOCOL ====================
    if (action === "ack-protocol") {
      const { agent_id } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const { data: protocol } = await supabase
        .from("design_space")
        .select("id, metadata")
        .eq("category", "protocol")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (protocol) {
        const readBy = protocol.metadata?.read_by || [];
        if (!readBy.includes(agent_id)) {
          readBy.push(agent_id);
        }
        await supabase
          .from("design_space")
          .update({ metadata: { ...protocol.metadata, read_by: readBy } })
          .eq("id", protocol.id);
      }

      return jsonResponse({ acknowledged: true, agent_id });
    }

    // ==================== LEGACY COMPATIBILITY ====================
    // Accept old task actions and route them through the unified system
    if (action === "post-task") {
      // Redirect to send with message_type: "work-order"
      const { from_agent, project, title, content, assignee, priority = "normal", topics = [], components = [] } = body;
      const thread_id = crypto.randomUUID();
      const embedding = await getEmbedding(`${title}\n${content}`);

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          project,
          topics,
          components,
          embedding,
          thread_id,
          metadata: {
            from_agent,
            from_platform: "claude-code",
            to_agent: assignee || null,
            message_type: "work-order",
            title,
            priority,
            status: "ready",
            claimed_by: null,
            claimed_at: null,
            completed_at: null,
            attachments: [],
            read_by: [],
          },
        })
        .select()
        .single();

      if (error) throw error;
      return jsonResponse({ message, task: message, thread_id });
    }

    if (action === "claim-task") {
      // Redirect to update-status
      const { task_id, agent_id } = body;
      const { data: existing } = await supabase.from("design_space").select("metadata").eq("id", task_id).single();
      if (!existing) return jsonResponse({ error: "Not found" }, 404);
      const updates = { ...existing.metadata, status: "in-progress", claimed_by: agent_id, claimed_at: new Date().toISOString() };
      const { data: message, error } = await supabase.from("design_space").update({ metadata: updates }).eq("id", task_id).select().single();
      if (error) throw error;
      return jsonResponse({ message, task: message });
    }

    if (action === "list-tasks") {
      // Redirect to check filtered by message_type
      const { project, assignee, status, limit = 20 } = body;
      let query = supabase.from("design_space").select("*").eq("category", "agent_message").eq("metadata->>message_type", "work-order").order("created_at", { ascending: false }).limit(limit);
      if (project) query = query.eq("project", project);
      if (status) query = query.eq("metadata->>status", status);
      if (assignee) query = query.eq("metadata->>to_agent", assignee);
      const { data: tasks, error } = await query;
      if (error) throw error;
      return jsonResponse({ tasks: tasks || [], count: (tasks || []).length });
    }

    if (action === "update-task") {
      // Redirect to update-status
      const { task_id, agent_id, status: newStatus, result } = body;
      const { data: existing } = await supabase.from("design_space").select("metadata").eq("id", task_id).single();
      if (!existing) return jsonResponse({ error: "Not found" }, 404);
      const updates: any = { ...existing.metadata };
      if (newStatus) { updates.status = newStatus; if (newStatus === "done") updates.completed_at = new Date().toISOString(); }
      if (result) updates.result = result;
      const { data: message, error } = await supabase.from("design_space").update({ metadata: updates }).eq("id", task_id).select().single();
      if (error) throw error;
      return jsonResponse({ message, task: message });
    }

    return jsonResponse({ error: `Invalid action. Use: send, check, respond, update-status, mark-read, thread, register, who-online, get-protocol, update-protocol, ack-protocol` }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
});

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
