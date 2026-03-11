// capture-visual: Screenshot + description → dual embedding (semantic + visual)
// POST { content, image_base64, category, project, designer, client, topics, components,
//        source, source_file, quality_score, pattern_type }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getSemanticEmbedding(text: string): Promise<number[]> {
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

  if (!response.ok) throw new Error(`Semantic embedding error: ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
}

async function getVisualEmbedding(imageBase64: string): Promise<number[]> {
  const voyageKey = Deno.env.get("VOYAGE_API_KEY");
  if (!voyageKey) throw new Error("VOYAGE_API_KEY not set");

  const response = await fetch("https://api.voyageai.com/v1/multimodalembeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${voyageKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "voyage-multimodal-3",
      inputs: [[{ type: "image", content: imageBase64 }]],
    }),
  });

  if (!response.ok) throw new Error(`Visual embedding error: ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      content, image_base64, category = "successful_pattern", project, designer,
      client, topics = [], components = [], source = "site-analysis",
      source_file, quality_score, pattern_type,
    } = await req.json();

    if (!content || !image_base64) {
      return new Response(JSON.stringify({ error: "content and image_base64 are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate both embeddings in parallel
    const [embedding, visual_embedding] = await Promise.all([
      getSemanticEmbedding(content),
      getVisualEmbedding(image_base64),
    ]);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: entry, error } = await supabase
      .from("design_space")
      .insert({
        content,
        category,
        project,
        designer,
        client,
        topics,
        components,
        source,
        source_file,
        quality_score,
        pattern_type,
        embedding,
        visual_embedding,
      })
      .select()
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({
      entry,
      embedding_dimensions: {
        semantic: embedding.length,
        visual: visual_embedding.length,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
