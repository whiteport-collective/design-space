// agent-messages: Cross-LLM, cross-IDE agent communication + work orders
// POST { action: "send" | "check" | "respond" | "register" | "who-online" | "mark-read" | "thread"
//                | "post-task" | "claim-task" | "list-tasks" | "update-task"
//                | "get-protocol" | "update-protocol" | "ack-protocol" }
// Messages stored in design_space table (category = "agent_message" | "task") — every entry is searchable knowledge

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getEmbedding(text: string): Promise<number[] | null> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) return null; // Embeddings are optional — messages/tasks work without them

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
    return null; // Don't block messaging if embedding fails
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
    if (action === "send") {
      const {
        content, from_agent, from_platform = "claude-code", to_agent,
        project, message_type = "notification", capabilities = [],
        priority = "normal", topics = [], components = [], attachments = [],
      } = body;

      if (!content || !from_agent) {
        return jsonResponse({ error: "content and from_agent are required" }, 400);
      }

      const thread_id = crypto.randomUUID();
      const embedding = await getEmbedding(content);

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
            from_platform,
            to_agent: to_agent || null,
            message_type,
            capabilities,
            priority,
            attachments,
            read_by: [],
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ message, thread_id });
    }

    // ==================== CHECK ====================
    if (action === "check") {
      const { agent_id, project, limit = 20 } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      // Derive base agent name if this is a session-scoped ID (e.g. "freya-2567" → "freya")
      const sessionMatch = agent_id.match(/^(.+)-(\d{4})$/);
      const baseAgentId = sessionMatch ? sessionMatch[1] : null;

      // Phase 1: All direct messages to this agent or its base name (no limit — never miss a direct message)
      const directIds = baseAgentId ? [agent_id, baseAgentId] : [agent_id];
      const { data: directMessages, error: directError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .in("metadata->>to_agent", directIds)
        .not("metadata", "cs", `{"read_by":["${agent_id}"]}`)
        .order("created_at", { ascending: false });

      if (directError) throw directError;

      // Phase 2: Recent broadcast messages (no specific to_agent) for ambient awareness
      const { data: broadcastMessages, error: broadcastError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .is("metadata->>to_agent", null)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (broadcastError) throw broadcastError;

      // Phase 3: Recent messages directed to other agents — cross-agent awareness
      // Needed when an agent checks under a generic ID (e.g. "claude-code") but messages
      // were addressed to their persona name (e.g. "ivonne", "codex")
      const { data: crossMessages, error: crossError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .not("metadata->>to_agent", "is", null)
        .neq("metadata->>to_agent", agent_id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (crossError) throw crossError;

      // Merge, deduplicate, filter already-read and own messages
      const seen = new Set<string>();
      const allMessages = [
        ...(directMessages || []),
        ...(broadcastMessages || []),
        ...(crossMessages || []),
      ].filter((m: any) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        const alreadyRead = (m.metadata?.read_by || []).includes(agent_id);
        const isOwnBroadcast = m.metadata?.to_agent == null && m.metadata?.from_agent === agent_id;
        return !alreadyRead && !isOwnBroadcast;
      });

      const unread = allMessages;

      // Compute signal strength for each message
      const scored = unread.map((m: any) => {
        const toAgent = m.metadata?.to_agent;
        const msgProject = m.project;
        const agentMatch = toAgent === agent_id;
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

      // Sort by signal strength, then by recency within each tier
      const signalOrder: Record<string, number> = { strong: 0, medium: 1, weak: 2, available: 3 };
      scored.sort((a: any, b: any) => {
        const diff = signalOrder[a.signal] - signalOrder[b.signal];
        if (diff !== 0) return diff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      // Fetch work orders assigned to this agent or unclaimed
      const { data: tasks, error: taskError } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "task")
        .in("metadata->>status", ["ready", "in-progress"])
        .or(`metadata->>assignee.eq.${agent_id},metadata->>assignee.is.null`)
        .order("created_at", { ascending: false })
        .limit(10);

      if (taskError) throw taskError;

      return jsonResponse({
        messages: scored,
        unread_count: scored.length,
        tasks: tasks || [],
        task_count: (tasks || []).length,
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

      // Resolve thread_id from message_id if not provided
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

      // Inherit project from original message if not provided
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

    // ==================== REGISTER ====================
    if (action === "register") {
      const {
        agent_id, agent_name, model, platform = "claude-code",
        framework, project, working_on, workspace,
        capabilities = [], tools_available = [],
        context_window, status = "online", pronouns,
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      // Generate a session-scoped ID if the caller passed a bare base name (e.g. "freya")
      // Session suffix = 4-digit number, e.g. "freya-2567"
      // Already-suffixed IDs (e.g. "freya-2567") are passed through unchanged.
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

      // Fetch who else is currently online (heartbeat within 5 minutes)
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: onlineAgents } = await supabase
        .from("agent_presence")
        .select("agent_id, agent_name, pronouns, project, working_on, last_heartbeat")
        .eq("status", "online")
        .gte("last_heartbeat", cutoff)
        .neq("agent_id", effectiveAgentId);

      return jsonResponse({
        agent,
        session_id: effectiveAgentId,
        session_code: code,
        online: onlineAgents || [],
      });
    }

    // ==================== WHO-ONLINE ====================
    if (action === "who-online") {
      const { project, capability } = body;

      // Consider agents online if heartbeat within last 5 minutes
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      let query = supabase
        .from("agent_presence")
        .select("*")
        .eq("status", "online")
        .gte("last_heartbeat", cutoff);

      if (project) {
        query = query.eq("project", project);
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

    // ==================== POST-TASK ====================
    if (action === "post-task") {
      const {
        from_agent, project, title, content, assignee,
        priority = "normal", topics = [], components = [],
      } = body;

      if (!content || !from_agent || !title) {
        return jsonResponse({ error: "content, from_agent, and title are required" }, 400);
      }

      const thread_id = crypto.randomUUID();
      const embedding = await getEmbedding(`${title}\n${content}`);

      const { data: task, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "task",
          project,
          topics,
          components,
          embedding,
          thread_id,
          metadata: {
            title,
            from_agent,
            assignee: assignee || null,
            priority,
            status: "ready",
            created_at: new Date().toISOString(),
            claimed_at: null,
            completed_at: null,
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ task, thread_id });
    }

    // ==================== CLAIM-TASK ====================
    if (action === "claim-task") {
      const { task_id, agent_id } = body;

      if (!task_id || !agent_id) {
        return jsonResponse({ error: "task_id and agent_id are required" }, 400);
      }

      const { data: existing } = await supabase
        .from("design_space")
        .select("metadata")
        .eq("id", task_id)
        .eq("category", "task")
        .single();

      if (!existing) {
        return jsonResponse({ error: "Task not found" }, 404);
      }

      if (existing.metadata?.status !== "ready") {
        return jsonResponse({ error: `Task is ${existing.metadata?.status}, not claimable` }, 409);
      }

      const { data: task, error } = await supabase
        .from("design_space")
        .update({
          metadata: {
            ...existing.metadata,
            assignee: agent_id,
            status: "in-progress",
            claimed_at: new Date().toISOString(),
          },
        })
        .eq("id", task_id)
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ task });
    }

    // ==================== LIST-TASKS ====================
    if (action === "list-tasks") {
      const { project, assignee, status, limit = 20 } = body;

      let query = supabase
        .from("design_space")
        .select("*")
        .eq("category", "task")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (project) query = query.eq("project", project);
      if (status) query = query.eq("metadata->>status", status);
      if (assignee) query = query.eq("metadata->>assignee", assignee);

      const { data: tasks, error } = await query;
      if (error) throw error;

      return jsonResponse({ tasks: tasks || [], count: (tasks || []).length });
    }

    // ==================== UPDATE-TASK ====================
    if (action === "update-task") {
      const { task_id, agent_id, status: newStatus, result } = body;

      if (!task_id || !agent_id) {
        return jsonResponse({ error: "task_id and agent_id are required" }, 400);
      }

      const { data: existing } = await supabase
        .from("design_space")
        .select("metadata")
        .eq("id", task_id)
        .eq("category", "task")
        .single();

      if (!existing) {
        return jsonResponse({ error: "Task not found" }, 404);
      }

      const updates: any = { ...existing.metadata };
      if (newStatus) {
        updates.status = newStatus;
        if (newStatus === "done") updates.completed_at = new Date().toISOString();
      }
      if (result) updates.result = result;

      const { data: task, error } = await supabase
        .from("design_space")
        .update({ metadata: updates })
        .eq("id", task_id)
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ task });
    }

    // ==================== GET-PROTOCOL ====================
    if (action === "get-protocol") {
      const { agent_id } = body;

      // Fetch the latest protocol entry
      const { data: protocol, error } = await supabase
        .from("design_space")
        .select("*")
        .eq("category", "protocol")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== "PGRST116") throw error; // PGRST116 = no rows

      if (!protocol) {
        return jsonResponse({ protocol: null, version: 0 });
      }

      // Check if this agent has seen this version
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

      // Upsert: delete old protocol, insert new one
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

    return jsonResponse({ error: `Invalid action. Use: send, check, respond, mark-read, thread, register, who-online, post-task, claim-task, list-tasks, update-task, get-protocol, update-protocol, ack-protocol` }, 400);
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
