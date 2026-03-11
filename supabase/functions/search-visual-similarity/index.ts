// search-visual-similarity: Find visually similar patterns via Voyage AI embeddings
// POST { image_base64, category, project, pattern_type, limit, threshold }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
      image_base64, category, project, pattern_type,
      limit = 5, threshold = 0.6,
    } = await req.json();

    if (!image_base64) {
      return new Response(JSON.stringify({ error: "image_base64 is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const visual_embedding = await getVisualEmbedding(image_base64);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase.rpc("search_visual_similarity", {
      query_embedding: visual_embedding,
      similarity_threshold: threshold,
      match_count: limit,
      filter_category: category || null,
      filter_project: project || null,
      filter_pattern_type: pattern_type || null,
    });

    if (error) throw error;

    return new Response(JSON.stringify({ results: data || [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
