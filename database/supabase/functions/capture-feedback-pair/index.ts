// capture-feedback-pair: Linked before/after design improvement with reasoning
// POST { before_description, before_image_base64, after_description, after_image_base64,
//        reasoning, pattern_type_before, pattern_type_after, project, designer, topics, components }

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
  const voyageKey = Deno.env.get("VOYAGE_API_KEY");
  if (!voyageKey || !imageBase64) return null;

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
      before_description, before_image_base64,
      after_description, after_image_base64,
      reasoning,
      pattern_type_before = "rejected",
      pattern_type_after = "approved",
      project, designer = "marten", topics = [], components = [],
    } = await req.json();

    if (!before_description || !after_description || !reasoning) {
      return new Response(JSON.stringify({
        error: "before_description, after_description, and reasoning are required",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate pair_id to link both entries
    const pair_id = crypto.randomUUID();

    // Generate embeddings in parallel
    const [beforeSemantic, afterSemantic, beforeVisual, afterVisual] = await Promise.all([
      getSemanticEmbedding(`${before_description}\n\nDesigner reasoning: ${reasoning}`),
      getSemanticEmbedding(`${after_description}\n\nDesigner reasoning: ${reasoning}`),
      getVisualEmbedding(before_image_base64),
      getVisualEmbedding(after_image_base64),
    ]);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Insert both entries as a linked pair
    const { data, error } = await supabase
      .from("design_space")
      .insert([
        {
          content: before_description,
          category: "client_feedback",
          project,
          designer,
          topics,
          components,
          source: "feedback-pair",
          pattern_type: pattern_type_before,
          pair_id,
          embedding: beforeSemantic,
          visual_embedding: beforeVisual,
          metadata: { reasoning, role: "before" },
        },
        {
          content: after_description,
          category: "client_feedback",
          project,
          designer,
          topics,
          components,
          source: "feedback-pair",
          pattern_type: pattern_type_after,
          pair_id,
          embedding: afterSemantic,
          visual_embedding: afterVisual,
          metadata: { reasoning, role: "after" },
        },
      ])
      .select();

    if (error) throw error;

    return new Response(JSON.stringify({
      pair_id,
      before: data[0],
      after: data[1],
      before_dims: {
        semantic: beforeSemantic.length,
        visual: beforeVisual?.length || 0,
      },
      after_dims: {
        semantic: afterSemantic.length,
        visual: afterVisual?.length || 0,
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
