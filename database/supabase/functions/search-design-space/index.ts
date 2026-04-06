// Legacy compatibility proxy: search-design-space -> search-knowledge

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const body = await req.text();
  const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/search-knowledge`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
      "Content-Type": "application/json",
    },
    body,
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
