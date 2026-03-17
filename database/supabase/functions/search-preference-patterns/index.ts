// search-preference-patterns: Red flag detection — check against known rejections
// POST { description, image_base64, project, designer, limit, semantic_threshold, visual_threshold }

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

async function getVisualEmbedding(imageBase64: string): Promise<number[] | null> {
  if (!imageBase64) return null;
  const voyageKey = Deno.env.get("VOYAGE_API_KEY");
  if (!voyageKey) return null;

  try {
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

  try {
    const {
      description, image_base64, project, designer = "marten",
      limit = 5, semantic_threshold = 0.75, visual_threshold = 0.70,
    } = await req.json();

    if (!description) {
      return new Response(JSON.stringify({ error: "description is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate embeddings
    const [semanticEmb, visualEmb] = await Promise.all([
      getSemanticEmbedding(description),
      getVisualEmbedding(image_base64),
    ]);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Search for rejected patterns that match semantically
    const { data: semanticMatches, error: semErr } = await supabase.rpc("search_design_space", {
      query_embedding: semanticEmb,
      similarity_threshold: semantic_threshold,
      match_count: limit,
      filter_category: null,
      filter_project: project || null,
      filter_designer: designer,
    });

    if (semErr) throw semErr;

    // Filter to only rejected patterns
    let results = (semanticMatches || []).filter((r: any) => r.pattern_type === "rejected");

    // For each rejected match, find its paired "approved" alternative
    for (const result of results) {
      if (result.pair_id) {
        const { data: paired } = await supabase
          .from("design_space")
          .select("content, pattern_type")
          .eq("pair_id", result.pair_id)
          .eq("pattern_type", "approved")
          .single();

        if (paired) {
          result.paired_content = paired.content;
        }
      }
      result.semantic_similarity = result.similarity || 0;
      result.visual_similarity = 0;
    }

    // Visual similarity check if image provided
    if (visualEmb) {
      const { data: visualMatches } = await supabase.rpc("search_visual_similarity", {
        query_embedding: visualEmb,
        similarity_threshold: visual_threshold,
        match_count: limit,
        filter_category: null,
        filter_project: project || null,
        filter_pattern_type: "rejected",
      });

      // Merge visual matches into results
      for (const vm of (visualMatches || [])) {
        const existing = results.find((r: any) => r.id === vm.id);
        if (existing) {
          existing.visual_similarity = vm.similarity || 0;
        } else {
          vm.semantic_similarity = 0;
          vm.visual_similarity = vm.similarity || 0;
          results.push(vm);
        }
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
