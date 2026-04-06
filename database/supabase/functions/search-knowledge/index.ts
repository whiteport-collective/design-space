// search-knowledge: Semantic search across Agent Space knowledge with filters
// POST { query, category, project, designer, topics, components, include_flagged?, limit, threshold }

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
      console.warn(`search-knowledge embedding unavailable: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.data[0]?.embedding ?? null;
  } catch (error) {
    console.warn("search-knowledge embedding request failed:", error);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      query,
      category,
      project,
      designer,
      topics,
      components,
      include_flagged = false,
      limit = 10,
      threshold = 0.3,
    } = await req.json();

    if (!query) {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const embedding = await getEmbedding(query);
    let results = [];

    if (embedding) {
      const { data, error } = await supabase.rpc("search_agent_space", {
        query_embedding: embedding,
        similarity_threshold: threshold,
        match_count: limit,
        filter_category: category || null,
        filter_project: project || null,
        filter_designer: designer || null,
        filter_include_flagged: include_flagged,
      });

      if (error) throw error;
      results = data || [];
    } else {
      let fallbackQuery = supabase
        .from("agent_space")
        .select("id, content, category, project, designer, client, topics, components, source, source_file, created_at, updated_at, flagged, pattern_type, pair_id, metadata")
        .ilike("content", `%${query}%`)
        .order("updated_at", { ascending: false })
        .limit(limit);

      if (category) fallbackQuery = fallbackQuery.eq("category", category);
      if (project) fallbackQuery = fallbackQuery.eq("project", project);
      if (designer) fallbackQuery = fallbackQuery.eq("designer", designer);
      if (!include_flagged) fallbackQuery = fallbackQuery.eq("flagged", false);

      const { data, error } = await fallbackQuery;
      if (error) throw error;

      results = (data || []).map((result: any) => ({
        ...result,
        similarity: null,
        match_type: "text",
      }));
    }
    if (topics && topics.length > 0) {
      results = results.filter((result: any) =>
        topics.some((topic: string) => (result.topics || []).includes(topic)),
      );
    }
    if (components && components.length > 0) {
      results = results.filter((result: any) =>
        components.some((component: string) => (result.components || []).includes(component)),
      );
    }

    return new Response(JSON.stringify({
      results,
      count: results.length,
      match_type: embedding ? "semantic" : "text-fallback",
      embedding_available: Boolean(embedding),
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
