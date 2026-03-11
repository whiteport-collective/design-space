// agent-messages: Cross-LLM, cross-IDE agent communication
// POST { action: "send" | "check" | "respond" | "register" | "who-online" | "mark-read" | "thread" }
// Messages stored in design_space table (category = "agent_message") — every message is searchable knowledge

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getEmbedding(text: string): Promise<number[]> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) throw new Error("OPENROUTER_API_KEY not set");

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

  if (!response.ok) throw new Error(`Embedding error: ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
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
            read: false,
          },
        })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ message, thread_id });
    }

    // ==================== CHECK ====================
    if (action === "check") {
      const { agent_id, project, include_broadcast = true, limit = 20 } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      let query = supabase
        .from("design_space")
        .select("*")
        .eq("category", "agent_message")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (project) {
        query = query.eq("project", project);
      }

      // Messages addressed to this agent OR broadcast (no to_agent)
      if (include_broadcast) {
        query = query.or(
          `metadata->>to_agent.eq.${agent_id},metadata->>to_agent.is.null`
        );
      } else {
        query = query.eq("metadata->>to_agent", agent_id);
      }

      const { data: messages, error } = await query;
      if (error) throw error;

      // Filter out own messages
      const unread = (messages || []).filter(
        (m: any) => m.metadata?.from_agent !== agent_id
      );

      return jsonResponse({
        messages: unread,
        unread_count: unread.length,
      });
    }

    // ==================== RESPOND ====================
    if (action === "respond") {
      const {
        message_id, thread_id: provided_thread_id,
        content, from_agent, from_platform = "claude-code",
        message_type = "answer", attachments = [],
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

      const { data: message, error } = await supabase
        .from("design_space")
        .insert({
          content,
          category: "agent_message",
          embedding,
          thread_id,
          metadata: {
            from_agent,
            from_platform,
            to_agent,
            message_type,
            attachments,
            read: false,
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
        context_window, status = "online",
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const { data: agent, error } = await supabase
        .from("agent_presence")
        .upsert({
          agent_id,
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
          last_heartbeat: new Date().toISOString(),
        }, { onConflict: "agent_id" })
        .select()
        .single();

      if (error) throw error;

      return jsonResponse({ agent });
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
      const { message_ids } = body;

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
          await supabase
            .from("design_space")
            .update({
              metadata: { ...existing.metadata, read: true },
            })
            .eq("id", id);
        }
      }

      return jsonResponse({ marked: message_ids.length });
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

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
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
