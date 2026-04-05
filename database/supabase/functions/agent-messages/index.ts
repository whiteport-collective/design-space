// agent-messages v25: mark-read requires disposition (handled | snoozed | read); snoozed re-surfaces next check
// POST { action: "send" | "check" | "respond" | "register" | "who-online" | "mark-read" | "thread"
//                | "update-status" | "get-protocol" | "update-protocol" | "ack-protocol"
//                | "wrap" | "get-presence" }
// Signal tiers: urgent (handoff, all 3 nodes: user+repo+agent) > strong > medium > weak > available
// User scoping: messages with a different user_id are hidden by default (include_others: true to override)
// All entries stored in agent_space (category = "agent_message") — every message is searchable knowledge
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
        .from("agent_space")
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
    // Signal tiers: urgent > strong > medium > weak > available
    // urgent   = handoff matching all 3 nodes: user_id + repo + agent
    // strong   = direct to agent + project match
    // medium   = direct to agent
    // weak     = project match
    // available = broadcast, no specific match
    // User scoping: messages with a different user_id are hidden by default
    if (action === "check") {
      const { agent_id, project, repo, user_id, include_others = false, limit = 50 } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      // Derive base agent name if session-scoped (e.g. "freya-2567" → "freya")
      const sessionMatch = agent_id.match(/^(.+)-(\d{4})$/);
      const baseAgentId = sessionMatch ? sessionMatch[1] : null;
      const directIds = baseAgentId ? [agent_id, baseAgentId] : [agent_id];

      // Phase 1: Direct messages to this agent (no limit — never miss a direct message)
      const { data: directMessages, error: directError } = await supabase
        .from("agent_space")
        .select("*")
        .eq("category", "agent_message")
        .in("metadata->>to_agent", directIds)
        .order("created_at", { ascending: false });

      if (directError) throw directError;

      // Phase 2: All other recent messages (broadcasts + messages to others)
      const { data: otherMessages, error: otherError } = await supabase
        .from("agent_space")
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

      // Filter: already-read, own messages, and other users' messages
      const filtered = allMessages.filter((m: any) => {
        const readBy = m.metadata?.read_by || [];
        if (readBy.includes(agent_id)) return false;
        if (baseAgentId && readBy.includes(baseAgentId)) return false;

        // Filter own messages — except handoffs (from yourself to your next session)
        const fromAgent = m.metadata?.from_agent;
        const msgType = m.metadata?.message_type;
        if (msgType !== "handoff") {
          if (fromAgent === agent_id) return false;
          if (baseAgentId && fromAgent === baseAgentId) return false;
        }

        // User scoping: hide messages that belong to a different user
        // Handoffs are always user-scoped. Other messages only if they carry a user_id.
        if (!include_others && user_id) {
          const msgUserId = m.metadata?.user_id;
          if (msgUserId && msgUserId !== user_id) return false;
        }

        return true;
      });

      // Compute signal strength
      const effectiveRepo = repo || project; // repo is canonical, project is fallback
      const scored = filtered.map((m: any) => {
        const toAgent = m.metadata?.to_agent;
        const msgProject = m.project;
        const msgRepo = m.metadata?.repo;
        const msgUserId = m.metadata?.user_id;
        const msgType = m.metadata?.message_type;

        const agentMatch = toAgent && directIds.includes(toAgent);
        const projectMatch = effectiveRepo && (msgProject === effectiveRepo || msgRepo === effectiveRepo);
        const userMatch = user_id && msgUserId === user_id;

        let signal: string;
        // urgent: handoff matching all 3 nodes — this is "your session is waiting"
        if (msgType === "handoff" && agentMatch && projectMatch && userMatch) {
          signal = "urgent";
        } else if (agentMatch && projectMatch) {
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
      const signalOrder: Record<string, number> = { urgent: 0, strong: 1, medium: 2, weak: 3, available: 4 };
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
          .from("agent_space")
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
          .from("agent_space")
          .select("project")
          .eq("id", message_id)
          .single();
        if (orig) resolvedProject = orig.project;
      }

      const { data: message, error } = await supabase
        .from("agent_space")
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
        .from("agent_space")
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
        .from("agent_space")
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
        framework, project, repo, working_on, workspace,
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
          project,
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
        .from("agent_space")
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
              .from("agent_space")
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
    // disposition is required — agents must actively decide the fate of every message:
    //   "handled"  — done, no follow-up needed
    //   "snoozed"  — keep visible next session (re-surfaces on next check)
    //   "read"     — acknowledged, not actionable
    if (action === "mark-read") {
      const { message_ids, agent_id, disposition } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }
      if (!message_ids || !Array.isArray(message_ids)) {
        return jsonResponse({ error: "message_ids array is required" }, 400);
      }
      if (!disposition || !["handled", "snoozed", "read"].includes(disposition)) {
        return jsonResponse({ error: "disposition is required: handled | snoozed | read" }, 400);
      }

      for (const id of message_ids) {
        const { data: existing } = await supabase
          .from("agent_space")
          .select("metadata")
          .eq("id", id)
          .single();

        if (existing) {
          const readBy = existing.metadata?.read_by || [];
          // Snoozed messages are NOT added to read_by — they re-surface on next check
          if (disposition !== "snoozed" && !readBy.includes(agent_id)) {
            readBy.push(agent_id);
          }
          // Record disposition per agent: { "freya-2567": "handled", "saga": "read" }
          const dispositions = existing.metadata?.dispositions || {};
          dispositions[agent_id] = disposition;

          await supabase
            .from("agent_space")
            .update({
              metadata: { ...existing.metadata, read_by: readBy, dispositions },
            })
            .eq("id", id);
        }
      }

      return jsonResponse({ marked: message_ids.length, agent_id, disposition });
    }

    // ==================== THREAD ====================
    if (action === "thread") {
      const { thread_id } = body;

      if (!thread_id) {
        return jsonResponse({ error: "thread_id is required" }, 400);
      }

      const { data: messages, error } = await supabase
        .from("agent_space")
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
        .from("agent_space")
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
        .from("agent_space")
        .delete()
        .eq("category", "protocol");

      const { data: protocol, error } = await supabase
        .from("agent_space")
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
        .from("agent_space")
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
          .from("agent_space")
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
        .from("agent_space")
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
      const { data: existing } = await supabase.from("agent_space").select("metadata").eq("id", task_id).single();
      if (!existing) return jsonResponse({ error: "Not found" }, 404);
      const updates = { ...existing.metadata, status: "in-progress", claimed_by: agent_id, claimed_at: new Date().toISOString() };
      const { data: message, error } = await supabase.from("agent_space").update({ metadata: updates }).eq("id", task_id).select().single();
      if (error) throw error;
      return jsonResponse({ message, task: message });
    }

    if (action === "list-tasks") {
      // Redirect to check filtered by message_type
      const { project, assignee, status, limit = 20 } = body;
      let query = supabase.from("agent_space").select("*").eq("category", "agent_message").eq("metadata->>message_type", "work-order").order("created_at", { ascending: false }).limit(limit);
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
      const { data: existing } = await supabase.from("agent_space").select("metadata").eq("id", task_id).single();
      if (!existing) return jsonResponse({ error: "Not found" }, 404);
      const updates: any = { ...existing.metadata };
      if (newStatus) { updates.status = newStatus; if (newStatus === "done") updates.completed_at = new Date().toISOString(); }
      if (result) updates.result = result;
      const { data: message, error } = await supabase.from("agent_space").update({ metadata: updates }).eq("id", task_id).select().single();
      if (error) throw error;
      return jsonResponse({ message, task: message });
    }

    // ==================== WRAP ====================
    // 1. Updates presence record (status → offline, last_status_report)
    // 2. Posts a handoff message so the next session's check() can find it
    //    Tagged with: agent, repo, user_id (optional) — supports many parallel sessions
    if (action === "wrap") {
      const { agent_id, repo, last_status_report, working_on, user_id } = body;
      if (!agent_id) return jsonResponse({ error: "agent_id is required" }, 400);

      // Derive base agent name (freya-2567 → freya)
      const sessionMatch = agent_id.match(/^(.+)-(\d{4})$/);
      const baseAgentId = sessionMatch ? sessionMatch[1] : agent_id;

      // 1. Update presence
      const { error: presenceError } = await supabase
        .from("agent_presence")
        .update({
          last_status_report,
          working_on: working_on || null,
          status: "offline",
          last_heartbeat: new Date().toISOString(),
        })
        .eq("agent_id", agent_id);

      if (presenceError) throw presenceError;

      // 2. Post handoff message — addressed to base agent so next session finds it via check()
      const handoffContent = last_status_report || working_on || "Session wrapped.";
      const embedding = await getEmbedding(handoffContent);
      const thread_id = crypto.randomUUID();

      const { data: handoffMessage, error: handoffError } = await supabase
        .from("agent_space")
        .insert({
          content: handoffContent,
          category: "agent_message",
          project: repo || null,
          embedding,
          thread_id,
          metadata: {
            from_agent: agent_id,
            from_platform: "claude-code",
            to_agent: baseAgentId,
            message_type: "handoff",
            repo: repo || null,
            user_id: user_id || null,
            working_on: working_on || null,
            read_by: [],
          },
        })
        .select()
        .single();

      if (handoffError) throw handoffError;

      return jsonResponse({ ok: true, handoff_id: handoffMessage.id });
    }

    // ==================== GET-PRESENCE ====================
    if (action === "get-presence") {
      const { agent_name, repo, project } = body;
      if (!agent_name || (!repo && !project)) {
        return jsonResponse({ error: "agent_name and either repo or project are required" }, 400);
      }

      let query = supabase
        .from("agent_presence")
        .select("agent_id, agent_name, project, repo, status, working_on, last_status_report, last_heartbeat")
        .eq("agent_name", agent_name)
        .order("last_heartbeat", { ascending: false })
        .limit(1);

      if (repo) query = query.eq("repo", repo);
      if (project) query = query.eq("project", project);

      const { data, error } = await query.single();

      if (error && error.code !== "PGRST116") throw error;
      return jsonResponse({ presence: data || null });
    }

    return jsonResponse({ error: `Invalid action. Use: send, check, respond, update-status, mark-read, thread, register, who-online, get-protocol, update-protocol, ack-protocol, wrap, get-presence` }, 400);
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

