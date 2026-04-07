// tool-calendar v1: Server-side Google Calendar proxy for Agent Space
// POST { action: "list" | "get" | "create" | "update" | "free-busy", org_id, user_id, ...params }
//
// Credentials flow (same as tool-gmail):
//   1. Org-level: client_id + client_secret from org_plugin_installations.config
//   2. User-level: refresh_token from user_vault (service: "google")
//   3. Access token refreshed automatically and cached in user_vault

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// --- OAuth2 token management (shared pattern with tool-gmail) ---

async function getAccessToken(
  supabase: ReturnType<typeof getSupabase>,
  orgId: string,
  userId: string,
): Promise<string> {
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
        `Connect via: POST /functions/v1/tool-oauth { action: "authorize", org_id, user_id, service: "google" }`,
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

  // Return cached token if still valid (60s buffer)
  if (creds.access_token && creds.token_expires_at && Date.now() < creds.token_expires_at - 60_000) {
    await supabase
      .from("user_vault")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", vault.id);
    return creds.access_token;
  }

  // Get org-level app credentials
  const { data: installation } = await supabase
    .from("org_plugin_installations")
    .select("config")
    .eq("org_id", orgId)
    .eq("plugin_slug", "tool_gmail") // shared Google OAuth app
    .single();

  const clientId = installation?.config?.google_client_id;
  const clientSecret = installation?.config?.google_client_secret;

  if (!clientId || !clientSecret) {
    throw new Error(`No Google OAuth app credentials in org ${orgId}.`);
  }

  // Refresh the token
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
    await supabase.from("user_vault").update({ status: "expired" }).eq("id", vault.id);
    throw new Error(`Token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  const newCreds = {
    ...creds,
    access_token: data.access_token,
    token_expires_at: Date.now() + data.expires_in * 1000,
  };

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

// --- Calendar API helpers ---

async function calFetch(token: string, path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
}

// --- Actions ---

async function listEvents(token: string, params: any) {
  const calendarId = params.calendar_id ?? "primary";
  const now = new Date();
  const timeMin = params.time_min ?? now.toISOString();
  const timeMax = params.time_max ?? new Date(now.getTime() + 7 * 86400000).toISOString();
  const maxResults = params.max_results ?? 20;

  const qs = new URLSearchParams({
    timeMin,
    timeMax,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const res = await calFetch(token, `calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
  if (!res.ok) throw new Error(`Calendar list: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return {
    events: (data.items ?? []).map((e: any) => ({
      id: e.id,
      summary: e.summary ?? "(no title)",
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location ?? null,
      description: e.description ?? null,
      status: e.status,
      attendees: (e.attendees ?? []).map((a: any) => ({
        email: a.email,
        name: a.displayName ?? null,
        response: a.responseStatus,
      })),
      hangout_link: e.hangoutLink ?? null,
      html_link: e.htmlLink ?? null,
    })),
    total: data.items?.length ?? 0,
  };
}

async function getEvent(token: string, params: any) {
  const { event_id, calendar_id = "primary" } = params;
  if (!event_id) throw new Error("event_id required");

  const res = await calFetch(token, `calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`);
  if (!res.ok) throw new Error(`Calendar get: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createEvent(token: string, params: any) {
  const { calendar_id = "primary", summary, start, end, description, location, attendees } = params;
  if (!summary || !start || !end) throw new Error("summary, start, end required");

  const event: any = {
    summary,
    start: typeof start === "string" ? { dateTime: start } : start,
    end: typeof end === "string" ? { dateTime: end } : end,
  };
  if (description) event.description = description;
  if (location) event.location = location;
  if (attendees) event.attendees = attendees.map((email: string) => ({ email }));

  const res = await calFetch(token, `calendars/${encodeURIComponent(calendar_id)}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`Calendar create: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, html_link: data.htmlLink, status: "created" };
}

async function updateEvent(token: string, params: any) {
  const { event_id, calendar_id = "primary", ...updates } = params;
  if (!event_id) throw new Error("event_id required");

  const patch: any = {};
  if (updates.summary) patch.summary = updates.summary;
  if (updates.start) patch.start = typeof updates.start === "string" ? { dateTime: updates.start } : updates.start;
  if (updates.end) patch.end = typeof updates.end === "string" ? { dateTime: updates.end } : updates.end;
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.location !== undefined) patch.location = updates.location;

  const res = await calFetch(
    token,
    `calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
  if (!res.ok) throw new Error(`Calendar update: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.id, html_link: data.htmlLink, status: "updated" };
}

async function freeBusy(token: string, params: any) {
  const now = new Date();
  const timeMin = params.time_min ?? now.toISOString();
  const timeMax = params.time_max ?? new Date(now.getTime() + 86400000).toISOString();
  const calendars = params.calendars ?? ["primary"];

  const res = await calFetch(token, "freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: calendars.map((id: string) => ({ id })),
    }),
  });
  if (!res.ok) throw new Error(`Calendar freeBusy: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const result: any = {};
  for (const [calId, cal] of Object.entries(data.calendars ?? {})) {
    result[calId] = { busy: (cal as any).busy ?? [] };
  }
  return { time_min: timeMin, time_max: timeMax, calendars: result };
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
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = getSupabase();
    const token = await getAccessToken(supabase, org_id, user_id);

    let result;
    switch (action) {
      case "list":
        result = await listEvents(token, params);
        break;
      case "get":
        result = await getEvent(token, params);
        break;
      case "create":
        result = await createEvent(token, params);
        break;
      case "update":
        result = await updateEvent(token, params);
        break;
      case "free-busy":
        result = await freeBusy(token, params);
        break;
      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}`, available: ["list", "get", "create", "update", "free-busy"] }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
