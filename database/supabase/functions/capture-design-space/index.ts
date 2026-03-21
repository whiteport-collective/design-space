// capture-design-space: Store design knowledge with semantic embedding
// POST { content, category, project, designer, client, topics, components, source, source_file, metadata }

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

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      content, category = "general", project, designer, client,
      topics = [], components = [], source, source_file, metadata,
    } = await req.json();

    if (!content) {
      return new Response(JSON.stringify({ error: "content is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate semantic embedding
    const embedding = await getEmbedding(content);

    // Store in database
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

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
      .from("design_space")
      .insert(insertPayload)
      .select()
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ entry }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
