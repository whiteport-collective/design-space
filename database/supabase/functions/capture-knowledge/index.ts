// capture-knowledge: Store or flag knowledge in Agent Space
// POST { content, category, project, designer, client, topics, components, source, source_file, metadata }
// POST { action: "flag", id, reason, superseded_by? }

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

    if (!response.ok) {
      console.warn(`capture-knowledge embedding unavailable: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    return data.data[0]?.embedding ?? null;
  } catch (error) {
    console.warn("capture-knowledge embedding request failed:", error);
    return null;
  }
}

function startFanOut(requestBody: Record<string, unknown>) {
  const fanOut = Array.isArray(requestBody.fan_out) ? requestBody.fan_out : [];
  if (fanOut.length === 0) {
    return;
  }

  const forwardedBody = { ...requestBody };
  delete forwardedBody.fan_out;

  queueMicrotask(() => {
    for (const target of fanOut) {
      if (!target || typeof target !== "object") {
        continue;
      }

      const url = typeof target.url === "string" ? target.url : "";
      const key = typeof target.key === "string" ? target.key : "";
      if (!url || !key) {
        continue;
      }

      fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(forwardedBody),
      }).catch((error) => {
        console.error(`Fan-out failed for ${typeof target.target === "string" ? target.target : url}:`, error);
      });
    }
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      action,
      id,
      reason,
      superseded_by,
      content,
      category = "general",
      project,
      designer,
      client,
      topics = [],
      components = [],
      source,
      source_file,
      metadata,
      fan_out,
    } = body;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "flag") {
      if (!id || !reason) {
        return new Response(JSON.stringify({ error: "id and reason are required for flag" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: existing, error: loadError } = await supabase
        .from("agent_space")
        .select("id, metadata")
        .eq("id", id)
        .single();

      if (loadError) throw loadError;

      const nextMetadata = {
        ...(existing?.metadata ?? {}),
        flag_reason: reason,
        flagged_at: new Date().toISOString(),
      };

      const updatePayload: Record<string, unknown> = {
        flagged: true,
        metadata: nextMetadata,
      };
      if (superseded_by) {
        updatePayload.superseded_by = superseded_by;
      }

      const { error: updateError } = await supabase
        .from("agent_space")
        .update(updatePayload)
        .eq("id", id);

      if (updateError) throw updateError;

      startFanOut({
        action,
        id,
        reason,
        superseded_by,
        fan_out,
      });

      return new Response(JSON.stringify({
        success: true,
        flagged: { id, reason, superseded_by: superseded_by ?? null },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!content) {
      return new Response(JSON.stringify({ error: "content is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const embedding = await getEmbedding(content);

    const insertPayload: Record<string, unknown> = {
      content,
      category,
      project,
      designer,
      client,
      topics,
      components,
      source,
      source_file,
      embedding,
    };

    if (metadata && typeof metadata === "object") {
      insertPayload.metadata = metadata;
    }

    const { data: entry, error } = await supabase
      .from("agent_space")
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    startFanOut({
      content,
      category,
      project,
      designer,
      client,
      topics,
      components,
      source,
      source_file,
      metadata,
      fan_out,
    });

    return new Response(JSON.stringify({ entry, embedding_available: Boolean(embedding) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
