// tool-gmail v2: Server-side Gmail proxy for Agent Space
// POST { action: "list" | "read" | "send" | "search", org_id, user_id, ...params }
//
// Credentials flow:
//   1. Org-level: client_id + client_secret from org_plugin_installations.config
//   2. User-level: refresh_token from user_vault (service: "google")
//   3. Access token refreshed automatically and cached in user_vault
//
// No env var secrets. Supports 1 user or 100.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// --- Supabase client ---

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

// --- OAuth2 token management ---

async function getAccessToken(
  supabase: ReturnType<typeof getSupabase>,
  orgId: string,
  userId: string
): Promise<string> {
  // 1. Get user's vault entry
  const { data: vault, error: vaultErr } = await supabase
    .from("user_vault")
    .select("id, credentials, status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("service", "google")
    .single();

  if (vaultErr || !vault) {
    throw new Error(
      `No Google credentials for user ${userId} in org ${orgId}. ` +
        `Connect via: POST /functions/v1/tool-oauth { action: "authorize", org_id, user_id, service: "google" }`
    );
  }

  if (vault.status !== "active") {
    throw new Error(`Google credentials are ${vault.status}. Please re-authorize.`);
  }

  const creds = vault.credentials as {
    refresh_token?: string;
    access_token?: string;
    token_expires_at?: number;
  };

  if (!creds.refresh_token) {
    throw new Error("No refresh token in vault. Please re-authorize with prompt=consent.");
  }

  // 2. Return cached token if still valid (60s buffer)
  if (creds.access_token && creds.token_expires_at && Date.now() < creds.token_expires_at - 60_000) {
    // Update last_used
    await supabase
      .from("user_vault")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", vault.id);
    return creds.access_token;
  }

  // 3. Get org-level app credentials
  const { data: installation } = await supabase
    .from("org_plugin_installations")
    .select("config")
    .eq("org_id", orgId)
    .eq("plugin_slug", "tool_gmail")
    .single();

  const clientId = installation?.config?.google_client_id;
  const clientSecret = installation?.config?.google_client_secret;

  if (!clientId || !clientSecret) {
    throw new Error(
      `No Google OAuth app credentials in org ${orgId}. ` +
        `Set google_client_id and google_client_secret in org_plugin_installations.config for tool_gmail.`
    );
  }

  // 4. Refresh the token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    // Mark as expired if refresh fails
    await supabase
      .from("user_vault")
      .update({ status: "expired" })
      .eq("id", vault.id);
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const newCreds = {
    ...creds,
    access_token: data.access_token,
    token_expires_at: Date.now() + data.expires_in * 1000,
  };

  // 5. Cache new token in vault
  await supabase
    .from("user_vault")
    .update({
      credentials: newCreds,
      last_refreshed_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    })
    .eq("id", vault.id);

  return data.access_token;
}

// --- Gmail API helpers ---

async function gmailFetch(
  token: string,
  path: string,
  opts?: RequestInit
): Promise<Response> {
  return fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
}

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function extractHeaders(
  headers: Array<{ name: string; value: string }>,
  names: string[]
): Record<string, string> {
  const result: Record<string, string> = {};
  const lower = names.map((n) => n.toLowerCase());
  for (const h of headers) {
    const idx = lower.indexOf(h.name.toLowerCase());
    if (idx !== -1) result[names[idx]] = h.value;
  }
  return result;
}

function extractBody(payload: any): { text: string; html: string } {
  const result = { text: "", html: "" };

  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === "text/html") result.html = decoded;
    else result.text = decoded;
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        result.text = decodeBase64Url(part.body.data);
      } else if (part.mimeType === "text/html" && part.body?.data) {
        result.html = decodeBase64Url(part.body.data);
      } else if (part.parts) {
        const nested = extractBody(part);
        if (!result.text && nested.text) result.text = nested.text;
        if (!result.html && nested.html) result.html = nested.html;
      }
    }
  }

  return result;
}

// --- Actions ---

async function listMessages(token: string, params: any) {
  const maxResults = params.max_results ?? 10;
  const label = params.label ?? "INBOX";
  const query = params.query ?? "";

  const qs = new URLSearchParams({
    maxResults: String(maxResults),
    labelIds: label,
  });
  if (query) qs.set("q", query);

  const res = await gmailFetch(token, `messages?${qs}`);
  if (!res.ok) throw new Error(`Gmail list: ${res.status} ${await res.text()}`);
  const data = await res.json();

  if (!data.messages?.length) return { messages: [], total: 0 };

  const details = await Promise.all(
    data.messages.map(async (m: any) => {
      const r = await gmailFetch(
        token,
        `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
      );
      if (!r.ok) return { id: m.id, error: true };
      const d = await r.json();
      const hdrs = extractHeaders(d.payload?.headers ?? [], [
        "From",
        "Subject",
        "Date",
      ]);
      return {
        id: m.id,
        thread_id: m.threadId,
        snippet: d.snippet,
        from: hdrs.From ?? "",
        subject: hdrs.Subject ?? "",
        date: hdrs.Date ?? "",
        labels: d.labelIds ?? [],
      };
    })
  );

  return { messages: details, total: data.resultSizeEstimate ?? details.length };
}

async function readMessage(token: string, params: any) {
  const { message_id } = params;
  if (!message_id) throw new Error("message_id required");

  const format = params.format ?? "full";
  const res = await gmailFetch(token, `messages/${message_id}?format=${format}`);
  if (!res.ok) throw new Error(`Gmail read: ${res.status} ${await res.text()}`);
  const msg = await res.json();

  if (format === "minimal") {
    return {
      id: msg.id,
      thread_id: msg.threadId,
      snippet: msg.snippet,
      labels: msg.labelIds,
    };
  }

  const headers = extractHeaders(msg.payload?.headers ?? [], [
    "From",
    "To",
    "Cc",
    "Subject",
    "Date",
    "Message-ID",
    "In-Reply-To",
  ]);
  const body = extractBody(msg.payload);

  return {
    id: msg.id,
    thread_id: msg.threadId,
    snippet: msg.snippet,
    labels: msg.labelIds,
    headers,
    body: body.text || body.html,
    has_html: !!body.html,
    attachments: (msg.payload?.parts ?? [])
      .filter((p: any) => p.filename && p.body?.attachmentId)
      .map((p: any) => ({
        id: p.body.attachmentId,
        filename: p.filename,
        mime_type: p.mimeType,
        size: p.body.size,
      })),
  };
}

async function sendMessage(token: string, params: any) {
  const { to, subject, body } = params;
  if (!to || !subject || !body) throw new Error("to, subject, body required");

  const cc = params.cc ? `Cc: ${params.cc}\r\n` : "";
  const bcc = params.bcc ? `Bcc: ${params.bcc}\r\n` : "";
  const replyTo = params.reply_to
    ? `In-Reply-To: ${params.reply_to}\r\nReferences: ${params.reply_to}\r\n`
    : "";

  const raw = [
    `To: ${to}\r\n`,
    `Subject: ${subject}\r\n`,
    cc,
    bcc,
    replyTo,
    `Content-Type: text/plain; charset=utf-8\r\n`,
    `\r\n`,
    body,
  ].join("");

  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmailFetch(token, "messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encoded }),
  });

  if (!res.ok) throw new Error(`Gmail send: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, thread_id: data.threadId, status: "sent" };
}

async function searchMessages(token: string, params: any) {
  const { query } = params;
  if (!query) throw new Error("query required");
  return listMessages(token, { ...params, label: undefined, query });
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { action, org_id, user_id, ...params } = await req.json();

    if (!org_id || !user_id) {
      return new Response(
        JSON.stringify({ error: "org_id and user_id required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = getSupabase();
    const token = await getAccessToken(supabase, org_id, user_id);

    let result;
    switch (action) {
      case "list":
        result = await listMessages(token, params);
        break;
      case "read":
        result = await readMessage(token, params);
        break;
      case "send":
        result = await sendMessage(token, params);
        break;
      case "search":
        result = await searchMessages(token, params);
        break;
      default:
        return new Response(
          JSON.stringify({
            error: `Unknown action: ${action}`,
            available: ["list", "read", "send", "search"],
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
