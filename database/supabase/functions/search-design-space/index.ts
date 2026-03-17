// search-design-space: Semantic search across knowledge with filters
// POST { query, category, project, designer, topics, components, limit, threshold }

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
    throw new Error(`Embedding API error: ${response.status}`);
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
      query, category, project, designer, topics, components,
      limit = 10, threshold = 0.3,
    } = await req.json();

    if (!query) {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const embedding = await getEmbedding(query);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Use RPC for vector similarity search
    const { data, error } = await supabase.rpc("search_design_space", {
      query_embedding: embedding,
      similarity_threshold: threshold,
      match_count: limit,
      filter_category: category || null,
      filter_project: project || null,
      filter_designer: designer || null,
    });

    if (error) throw error;

    // Post-filter by topics and components if provided
    let results = data || [];
    if (topics && topics.length > 0) {
      results = results.filter((r: any) =>
        topics.some((t: string) => (r.topics || []).includes(t))
      );
    }
    if (components && components.length > 0) {
      results = results.filter((r: any) =>
        components.some((c: string) => (r.components || []).includes(c))
      );
    }

    return new Response(JSON.stringify({ results, count: results.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
