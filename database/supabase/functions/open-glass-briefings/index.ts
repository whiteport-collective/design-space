import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function fail(message: string, status = 400) {
  return ok({ error: message }, status);
}

function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function hasBearer(req: Request) {
  return Boolean(req.headers.get("authorization")?.startsWith("Bearer "));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!hasBearer(req)) {
    return fail("unauthorized", 401);
  }

  if (req.method !== "POST") {
    return fail("method_not_allowed", 405);
  }

  try {
    const body = await req.json();
    const action = body?.action;
    const orgId = String(body?.org_id ?? "whiteport").trim();
    const project = String(body?.project ?? "").trim();
    const repo = String(body?.repo ?? "").trim();
    const viewSlug = String(body?.view_slug ?? "open-glass").trim();
    const audienceScope = String(body?.audience_scope ?? "admin-dashboard").trim();

    if (!action) {
      return fail("action is required");
    }

    if (!project) {
      return fail("project is required");
    }

    const client = db();

    if (action === "publish") {
      const payload = body?.payload;
      const generatedAt = String(body?.generated_at ?? new Date().toISOString());
      const freshnessAt = String(body?.freshness_at ?? generatedAt);

      if (!payload || typeof payload !== "object") {
        return fail("payload is required");
      }

      const supersede = await client
        .from("open_glass_briefings")
        .update({
          superseded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("org_id", orgId)
        .eq("project", project)
        .eq("repo", repo)
        .eq("view_slug", viewSlug)
        .eq("audience_scope", audienceScope)
        .is("superseded_at", null);

      if (supersede.error) {
        throw supersede.error;
      }

      const inserted = await client
        .from("open_glass_briefings")
        .insert({
          org_id: orgId,
          project,
          repo,
          view_slug: viewSlug,
          audience_scope: audienceScope,
          payload,
          generated_at: generatedAt,
          freshness_at: freshnessAt,
        })
        .select("*")
        .single();

      if (inserted.error) {
        throw inserted.error;
      }

      return ok({ briefing: inserted.data });
    }

    if (action === "get-latest") {
      const latest = await client
        .from("open_glass_briefings")
        .select("*")
        .eq("org_id", orgId)
        .eq("project", project)
        .eq("repo", repo)
        .eq("view_slug", viewSlug)
        .eq("audience_scope", audienceScope)
        .is("superseded_at", null)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latest.error) {
        throw latest.error;
      }

      return ok({ briefing: latest.data ?? null });
    }

    if (action === "list") {
      const limit = Math.max(1, Math.min(20, Number(body?.limit ?? 10)));
      const rows = await client
        .from("open_glass_briefings")
        .select("*")
        .eq("org_id", orgId)
        .eq("project", project)
        .eq("repo", repo)
        .eq("view_slug", viewSlug)
        .eq("audience_scope", audienceScope)
        .order("generated_at", { ascending: false })
        .limit(limit);

      if (rows.error) {
        throw rows.error;
      }

      return ok({ briefings: rows.data ?? [] });
    }

    return fail(`unknown action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown open glass error";
    return fail(message, 500);
  }
});
