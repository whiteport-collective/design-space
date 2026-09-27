// tool-publer v2: Publer social media proxy for Agent Space
// POST { action, ...params }
//
// Actions:
//   create_post    — Publish or schedule a post on one or more platforms (confirm before calling)
//   list_scheduled — List upcoming scheduled posts (safe)
//   delete_post    — Delete or cancel a scheduled post (confirm before calling)
//   get_analytics  — Get engagement stats for a published post (safe)
//
// Platforms: facebook, instagram, linkedin
// Accounts:  Whiteport business pages only — personal profiles use tool-unipile
//
// Auth: PUBLER_API_KEY (Supabase secret), no user_vault, no OAuth

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PUBLER_BASE = "https://app.publer.com/api/v1";
const PUBLER_WORKSPACE_ID = "69b3e8976fa20cf04059d3c2"; // Whiteport Business

function getPubilerKey(): string {
  const key = Deno.env.get("PUBLER_API_KEY");
  if (!key) throw new Error("PUBLER_API_KEY not set in Supabase secrets.");
  return key;
}

async function publerFetch(apiKey: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${PUBLER_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer-API ${apiKey}`,
      "Publer-Workspace-Id": PUBLER_WORKSPACE_ID,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Publer API error ${res.status}: ${err}`);
  }

  return res.json();
}

// --- Actions ---

async function actionDebug(apiKey: string, params: Record<string, unknown>) {
  const { path = "/posts", method = "GET", body } = params as { path?: string; method?: string; body?: unknown };
  const res = await fetch(`${PUBLER_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer-API ${apiKey}`,
      "Publer-Workspace-Id": PUBLER_WORKSPACE_ID,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, response: json };
}

async function actionCreatePost(apiKey: string, params: Record<string, unknown>) {
  const { platforms, content, media, scheduled_at, labels } = params as {
    platforms: string[];
    content: string;
    media?: string[];
    scheduled_at?: string;
    labels?: string[];
  };

  if (!platforms || platforms.length === 0) throw new Error("platforms[] is required");
  if (!content) throw new Error("content is required");

  const validPlatforms = ["facebook", "instagram", "linkedin"];
  for (const p of platforms) {
    if (!validPlatforms.includes(p)) {
      throw new Error(`Invalid platform: ${p}. Valid: ${validPlatforms.join(", ")}`);
    }
  }

  const body: Record<string, unknown> = { platforms, caption: content };

  if (media && media.length > 0) {
    body.media_items = media.map((url) => ({ type: "photo", url }));
  }

  if (scheduled_at) body.scheduled_at = scheduled_at;
  if (labels && labels.length > 0) body.labels = labels;

  const data = await publerFetch(apiKey, "/posts", "POST", body);
  return {
    post_id: data.post?.id ?? data.id ?? null,
    status: data.post?.status ?? data.status ?? "created",
    platforms,
    scheduled_at: scheduled_at ?? null,
    url: data.post?.url ?? null,
  };
}

async function actionListScheduled(apiKey: string, params: Record<string, unknown>) {
  const { platform, limit } = params as { platform?: string; limit?: number };
  let path = `/posts?status=scheduled&limit=${limit ?? 20}`;
  if (platform) path += `&platform=${platform}`;

  const data = await publerFetch(apiKey, path);
  const posts = data.posts ?? data.items ?? data ?? [];
  return { posts, count: posts.length };
}

async function actionDeletePost(apiKey: string, params: Record<string, unknown>) {
  const { post_id } = params as { post_id: string };
  if (!post_id) throw new Error("post_id is required");

  await publerFetch(apiKey, `/posts/${post_id}`, "DELETE");
  return { deleted: true, post_id };
}

async function actionGetAnalytics(apiKey: string, params: Record<string, unknown>) {
  const { post_id } = params as { post_id: string };
  if (!post_id) throw new Error("post_id is required");

  const data = await publerFetch(apiKey, `/analytics/${post_id}`);
  return data;
}

// --- Usage logging (fire-and-forget, zero latency impact) ---

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function logUsage(
  supabase: ReturnType<typeof getSupabase>,
  action: string,
  ok: boolean,
  durationMs: number,
  metadata?: Record<string, unknown>,
  errorMsg?: string,
) {
  supabase.from("tool_usage_log").insert({
    tool_slug: "tool-publer",
    action,
    ok,
    duration_ms: durationMs,
    error_msg: errorMsg ?? null,
    metadata: metadata ?? null,
  }).then(() => {}).catch(() => {});
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const start = Date.now();

  try {
    const { action, ...params } = await req.json();

    if (!action) {
      return new Response(
        JSON.stringify({
          error: "action is required",
          available: ["create_post", "list_scheduled", "delete_post", "get_analytics"],
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const apiKey = getPubilerKey();
    const supabase = getSupabase();
    let result: unknown;
    let meta: Record<string, unknown> = {};

    switch (action) {
      case "create_post": {
        result = await actionCreatePost(apiKey, params);
        const r = result as Record<string, unknown>;
        meta = { platforms: params.platforms, scheduled: !!params.scheduled_at, status: r.status };
        break;
      }
      case "list_scheduled":
        result = await actionListScheduled(apiKey, params);
        meta = { count: (result as Record<string, unknown>).count, platform: params.platform ?? null };
        break;
      case "delete_post":
        result = await actionDeletePost(apiKey, params);
        break;
      case "get_analytics":
        result = await actionGetAnalytics(apiKey, params);
        break;
      case "debug":
        result = await actionDebug(apiKey, params);
        break;
      default:
        return new Response(
          JSON.stringify({
            error: `Unknown action: ${action}`,
            available: ["create_post", "list_scheduled", "delete_post", "get_analytics"],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
    }

    const response = new Response(JSON.stringify({ ok: true, ...((result as object) ?? {}) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

    logUsage(supabase, action, true, Date.now() - start, meta);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const supabase = getSupabase();
    logUsage(supabase, "unknown", false, Date.now() - start, {}, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
