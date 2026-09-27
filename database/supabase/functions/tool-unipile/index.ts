// tool-unipile v2: LinkedIn proxy via Unipile API (corrected paths)
// POST { action, ...params }
//
// Actions:
//   post            — Publish a LinkedIn post (confirm before calling)
//   message         — Send a DM (confirm before calling)
//   connect         — Send connection request (confirm before calling)
//   notifications   — Fetch unread DMs (safe)
//   search          — Search LinkedIn profiles (safe)
//   sync            — Bulk sync messages + activity into cache (safe)
//   cache-search    — Full-text search across cached data (safe, instant)
//   cache-stats     — Cache health report (safe)
//
// Auth: UNIPILE_API_KEY (Supabase secret), UNIPILE_ACCOUNT_ID, UNIPILE_BASE_URL
// Account: UNIPILE_ACCOUNT_ID (Mårten's personal LinkedIn)
//
// Note: reply-comment is not supported by the Unipile API.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function getUnipileConfig() {
  const apiKey = Deno.env.get("UNIPILE_API_KEY");
  const accountId = Deno.env.get("UNIPILE_ACCOUNT_ID");
  const baseUrl = Deno.env.get("UNIPILE_BASE_URL") || "https://api22.unipile.com:15258/api/v1";
  if (!apiKey) throw new Error("UNIPILE_API_KEY not set in Supabase secrets.");
  if (!accountId) throw new Error("UNIPILE_ACCOUNT_ID not set in Supabase secrets.");
  return { apiKey, accountId, baseUrl };
}

async function unipileFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  method = "GET",
  body?: unknown,
  isFormData = false,
) {
  const headers: Record<string, string> = {
    "X-API-KEY": apiKey,
    "Accept": "application/json",
  };
  if (body && !isFormData) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: isFormData ? (body as FormData) : (body ? JSON.stringify(body) : undefined),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile API error ${res.status}: ${err}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

// --- Markdown → Unicode formatting (LinkedIn doesn't support HTML/markdown) ---

function toUnicodeBold(text: string): string {
  return [...text].map(c => {
    const cp = c.codePointAt(0)!;
    if (cp >= 65 && cp <= 90) return String.fromCodePoint(0x1D5D4 + cp - 65);
    if (cp >= 97 && cp <= 122) return String.fromCodePoint(0x1D5EE + cp - 97);
    if (cp >= 48 && cp <= 57) return String.fromCodePoint(0x1D7EC + cp - 48);
    return c;
  }).join('');
}

function toUnicodeItalic(text: string): string {
  return [...text].map(c => {
    const cp = c.codePointAt(0)!;
    if (cp >= 65 && cp <= 90) return String.fromCodePoint(0x1D608 + cp - 65);
    if (cp >= 97 && cp <= 122) return String.fromCodePoint(0x1D622 + cp - 97);
    return c;
  }).join('');
}

function applyMarkdown(text: string): string {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/gs, (_, t) => toUnicodeBold(toUnicodeItalic(t)))
    .replace(/\*\*(.+?)\*\*/gs, (_, t) => toUnicodeBold(t))
    .replace(/\*(.+?)\*/gs, (_, t) => toUnicodeItalic(t));
}

// --- Actions ---

async function actionPost(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { content, media, repost, as_organization } = params as {
    content?: string;
    media?: Array<{ data: string; type?: string; filename?: string; url?: string }>;
    repost?: string;
    as_organization?: string;
  };

  if (!content && !repost) throw new Error("content or repost is required");

  const form = new FormData();
  form.append("account_id", config.accountId);
  if (content !== undefined) form.append("text", applyMarkdown(content));  // empty string valid for reposts
  if (repost) form.append("repost", repost);
  if (as_organization) form.append("as_organization", as_organization);

  if (media && media.length > 0) {
    for (const item of media) {
      let blob: Blob;
      if (item.data) {
        const binary = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
        blob = new Blob([binary], { type: item.type ?? "image/jpeg" });
      } else if (item.url) {
        const imgRes = await fetch(item.url);
        if (!imgRes.ok) throw new Error(`Failed to fetch media URL: ${item.url}`);
        blob = await imgRes.blob();
      } else {
        continue;
      }
      form.append("attachments", blob, item.filename ?? "image.jpg");
    }
  }

  const res = await fetch(`${config.baseUrl}/posts`, {
    method: "POST",
    headers: { "X-API-KEY": config.apiKey, "Accept": "application/json" },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return { post_id: data.post_id ?? data.id ?? null };
}

async function actionGetCompany(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { identifier } = params as { identifier: string };
  if (!identifier) throw new Error("identifier is required");

  const data = await unipileFetch(
    config.baseUrl, config.apiKey,
    `/linkedin/company/${encodeURIComponent(identifier)}?account_id=${config.accountId}`,
  );
  return data;
}

async function actionMessage(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { to, chat_id, content } = params as { to?: string; chat_id?: string; content: string };
  if (!content) throw new Error("content is required");
  if (!to && !chat_id) throw new Error("Either 'to' (provider_id) or 'chat_id' is required");

  let resolvedChatId = chat_id;

  if (!resolvedChatId && to) {
    // Find or create chat with this person
    const chatData = await unipileFetch(
      config.baseUrl, config.apiKey,
      "/chats",
      "POST",
      { account_id: config.accountId, attendees_ids: [to] },
    );
    resolvedChatId = chatData.id;
  }

  const data = await unipileFetch(
    config.baseUrl, config.apiKey,
    `/chats/${resolvedChatId}/messages`,
    "POST",
    { account_id: config.accountId, text: content },
  );
  return { message_id: data.id ?? null };
}

async function actionConnect(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { provider_id, message } = params as { provider_id: string; message?: string };
  if (!provider_id) throw new Error("provider_id is required");
  if (message && message.length > 300) throw new Error("Connection message must be max 300 characters");

  const body: Record<string, unknown> = {
    account_id: config.accountId,
    provider_id,
  };
  if (message) body.message = message;

  const data = await unipileFetch(config.baseUrl, config.apiKey, "/users/invite", "POST", body);
  return { request_id: data.id ?? null };
}

async function actionComment(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { post_id, content } = params as { post_id: string; content: string };
  if (!post_id) throw new Error("post_id is required");
  if (!content) throw new Error("content is required");

  const form = new FormData();
  form.append("account_id", config.accountId);
  form.append("text", content);

  const res = await fetch(`${config.baseUrl}/posts/${post_id}/comments`, {
    method: "POST",
    headers: { "X-API-KEY": config.apiKey, "Accept": "application/json" },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unipile API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return { comment_id: data.comment_id ?? data.id ?? null };
}

async function actionNotifications(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  // Returns unread DMs — closest equivalent to LinkedIn notifications via Unipile API
  const limit = Number(params.limit) || 20;
  const data = await unipileFetch(
    config.baseUrl, config.apiKey,
    `/messages?account_id=${config.accountId}&seen=false&limit=${limit}`,
  );
  const items = data.items ?? data ?? [];
  return { messages: items, count: items.length };
}

async function actionSearch(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>) {
  const { query, limit } = params as { query: string; limit?: number };
  if (!query) throw new Error("query is required");

  const data = await unipileFetch(
    config.baseUrl, config.apiKey,
    `/users/search?account_id=${config.accountId}&query=${encodeURIComponent(query)}&limit=${limit ?? 10}`,
  );
  const items = data.items ?? data ?? [];
  return { results: items, count: items.length };
}

async function actionSync(config: ReturnType<typeof getUnipileConfig>, params: Record<string, unknown>, supabase: ReturnType<typeof getSupabase>) {
  const maxResults = Number(params.max_results) || 50;
  let syncedMessages = 0;
  let syncedActivity = 0;
  let skipped = 0;

  // Sync messages
  try {
    const messagesData = await unipileFetch(
      config.baseUrl, config.apiKey,
      `/messages?account_id=${config.accountId}&limit=${maxResults}`,
    );
    const messages = messagesData.items ?? messagesData ?? [];

    for (const msg of messages) {
      const { error } = await supabase
        .from("linkedin_message_cache")
        .upsert({
          id: msg.id,
          chat_id: msg.chat_id ?? "unknown",
          sender_name: msg.sender_attendee_id ?? null,
          sender_profile_id: msg.sender_attendee_id ?? null,
          content: msg.text ?? null,
          sent_at: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null,
          is_read: msg.seen ?? false,
        }, { onConflict: "id", ignoreDuplicates: true });

      if (error) skipped++;
      else syncedMessages++;
    }
  } catch (_e) {
    // Messages sync failure is non-fatal
  }

  // Prune to 200 rows each
  await supabase.rpc("prune_linkedin_message_cache", { max_rows: 200 }).maybeSingle();
  await supabase.rpc("prune_linkedin_activity_cache", { max_rows: 200 }).maybeSingle();

  return {
    synced_messages: syncedMessages,
    synced_activity: syncedActivity,
    skipped,
  };
}

async function actionCacheSearch(params: Record<string, unknown>, supabase: ReturnType<typeof getSupabase>) {
  const { query, limit } = params as { query: string; limit?: number };
  if (!query) throw new Error("query is required");

  const [msgResult, actResult] = await Promise.all([
    supabase
      .from("linkedin_message_cache")
      .select("id, chat_id, sender_name, content, sent_at, is_read")
      .textSearch("search_vector", query, { type: "websearch" })
      .order("sent_at", { ascending: false })
      .limit(limit ?? 20),
    supabase
      .from("linkedin_activity_cache")
      .select("id, post_id, type, actor_name, content, activity_at, post_snippet")
      .textSearch("search_vector", query, { type: "websearch" })
      .order("activity_at", { ascending: false })
      .limit(limit ?? 20),
  ]);

  return {
    messages: msgResult.data ?? [],
    activity: actResult.data ?? [],
    total: (msgResult.data?.length ?? 0) + (actResult.data?.length ?? 0),
  };
}

async function actionCacheStats(supabase: ReturnType<typeof getSupabase>) {
  const [msgStats, actStats] = await Promise.all([
    supabase.from("linkedin_message_cache").select("sent_at").order("sent_at", { ascending: true }).limit(1),
    supabase.from("linkedin_activity_cache").select("activity_at").order("activity_at", { ascending: true }).limit(1),
  ]);

  const [msgCount, actCount] = await Promise.all([
    supabase.from("linkedin_message_cache").select("id", { count: "exact", head: true }),
    supabase.from("linkedin_activity_cache").select("id", { count: "exact", head: true }),
  ]);

  return {
    messages: { count: msgCount.count ?? 0, oldest: msgStats.data?.[0]?.sent_at ?? null },
    activity: { count: actCount.count ?? 0, oldest: actStats.data?.[0]?.activity_at ?? null },
  };
}

// --- Usage logging (fire-and-forget, zero latency impact) ---

function logUsage(
  supabase: ReturnType<typeof getSupabase>,
  action: string,
  ok: boolean,
  durationMs: number,
  metadata?: Record<string, unknown>,
  errorMsg?: string,
) {
  supabase.from("tool_usage_log").insert({
    tool_slug: "tool-unipile",
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
        JSON.stringify({ error: "action is required", available: ["post", "comment", "message", "connect", "notifications", "search", "sync", "cache-search", "cache-stats"] }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const config = getUnipileConfig();
    const supabase = getSupabase();
    let result: unknown;
    let meta: Record<string, unknown> = {};

    switch (action) {
      case "post":
        result = await actionPost(config, params);
        break;
      case "comment":
        result = await actionComment(config, params);
        break;
      case "get-company":
        result = await actionGetCompany(config, params);
        break;
      case "message":
        meta = { has_chat_id: !!params.chat_id, has_to: !!params.to };
        result = await actionMessage(config, params);
        break;
      case "connect":
        result = await actionConnect(config, params);
        break;
      case "notifications":
        result = await actionNotifications(config, params);
        meta = { count: (result as Record<string, unknown>).count };
        break;
      case "search":
        result = await actionSearch(config, params);
        meta = { query_length: String(params.query ?? "").length, count: (result as Record<string, unknown>).count };
        break;
      case "sync":
        result = await actionSync(config, params, supabase);
        meta = result as Record<string, unknown>;
        break;
      case "cache-search":
        result = await actionCacheSearch(params, supabase);
        meta = { total: (result as Record<string, unknown>).total };
        break;
      case "cache-stats":
        result = await actionCacheStats(supabase);
        break;
      case "reply-comment":
        return new Response(
          JSON.stringify({ error: "reply-comment is not supported by the Unipile API. Reply via LinkedIn app or use 'message' to DM the commenter." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}`, available: ["post", "comment", "message", "connect", "notifications", "search", "sync", "cache-search", "cache-stats"] }),
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
