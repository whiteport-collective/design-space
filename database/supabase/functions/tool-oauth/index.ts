// tool-oauth v1: OAuth connector for Agent Space toolbox
// Handles authorization flows and stores tokens in user_vault.
// Org-level app credentials live in org_plugin_installations.config.
// Per-user tokens live in user_vault.
//
// Actions:
//   authorize  — returns auth URL for user to visit
//   callback   — exchanges auth code for tokens, stores in vault
//   status     — checks if user has valid credentials for a service
//   revoke     — removes credentials from vault

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function error(msg: string, status = 400) {
  return json({ error: msg }, status);
}

// --- Supabase client (service role for vault writes) ---

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

// --- Service configs ---

interface ServiceConfig {
  auth_url: string;
  token_url: string;
  default_scopes: string[];
}

const SERVICES: Record<string, ServiceConfig> = {
  google: {
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    default_scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
    ],
  },
};

// --- Get org-level OAuth app credentials ---

async function getOrgAppCredentials(
  supabase: ReturnType<typeof getSupabase>,
  orgId: string,
  service: string
): Promise<{ client_id: string; client_secret: string }> {
  // Look in org_plugin_installations.config for the tool that uses this service
  const { data } = await supabase
    .from("org_plugin_installations")
    .select("config")
    .eq("org_id", orgId)
    .eq("plugin_slug", `tool_${service === "google" ? "gmail" : service}`)
    .single();

  const clientId = data?.config?.google_client_id;
  const clientSecret = data?.config?.google_client_secret;

  if (!clientId || !clientSecret) {
    throw new Error(
      `No OAuth app credentials configured for ${service} in org ${orgId}. ` +
        `Set google_client_id and google_client_secret in org_plugin_installations.config.`
    );
  }

  return { client_id: clientId, client_secret: clientSecret };
}

// --- Actions ---

async function authorize(params: {
  org_id: string;
  user_id: string;
  service: string;
  scopes?: string[];
  redirect_after?: string;
}) {
  const { org_id, user_id, service } = params;
  if (!org_id || !user_id || !service) {
    throw new Error("org_id, user_id, service required");
  }

  const svc = SERVICES[service];
  if (!svc) throw new Error(`Unsupported service: ${service}`);

  const supabase = getSupabase();
  const { client_id } = await getOrgAppCredentials(supabase, org_id, service);

  const scopes = params.scopes ?? svc.default_scopes;

  // Generate random state
  const state = crypto.randomUUID().replace(/-/g, "").slice(0, 32);

  // Store state for callback verification
  await supabase.from("oauth_state").insert({
    state,
    org_id,
    user_id,
    service,
    scopes,
    redirect_after: params.redirect_after ?? null,
  });

  // Build auth URL
  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tool-oauth?action=callback`;

  const authUrl = new URL(svc.auth_url);
  authUrl.searchParams.set("client_id", client_id);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force refresh token

  return { auth_url: authUrl.toString(), state };
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return new Response(
      `<html><body><h2>Authorization failed</h2><p>${errorParam}</p></body></html>`,
      { status: 400, headers: { "Content-Type": "text/html" } }
    );
  }

  if (!code || !state) {
    return error("Missing code or state parameter");
  }

  const supabase = getSupabase();

  // Verify state
  const { data: stateRow } = await supabase
    .from("oauth_state")
    .select("*")
    .eq("state", state)
    .single();

  if (!stateRow) {
    return error("Invalid or expired state parameter");
  }

  // Clean up state row
  await supabase.from("oauth_state").delete().eq("state", state);

  // Check expiry
  if (new Date(stateRow.expires_at) < new Date()) {
    return error("Authorization flow expired. Please start again.");
  }

  const svc = SERVICES[stateRow.service];
  if (!svc) return error(`Unknown service: ${stateRow.service}`);

  // Get org app credentials
  const { client_id, client_secret } = await getOrgAppCredentials(
    supabase,
    stateRow.org_id,
    stateRow.service
  );

  const callbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tool-oauth?action=callback`;

  // Exchange code for tokens
  const tokenRes = await fetch(svc.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return error(`Token exchange failed: ${tokenRes.status} ${err}`, 502);
  }

  const tokens = await tokenRes.json();

  // Store in vault
  const credentials: Record<string, unknown> = {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    token_expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };

  await supabase.from("user_vault").upsert(
    {
      org_id: stateRow.org_id,
      user_id: stateRow.user_id,
      service: stateRow.service,
      credential_type: "oauth2",
      credentials,
      scopes: stateRow.scopes,
      status: "active",
      last_refreshed_at: new Date().toISOString(),
    },
    { onConflict: "org_id,user_id,service" }
  );

  // Success page
  const redirectAfter = stateRow.redirect_after;
  const html = redirectAfter
    ? `<html><head><meta http-equiv="refresh" content="2;url=${redirectAfter}"></head>` +
      `<body><h2>Connected!</h2><p>Redirecting...</p></body></html>`
    : `<html><body><h2>Connected!</h2><p>${stateRow.service} is now linked to your Agent Space account. You can close this tab.</p></body></html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function status(params: {
  org_id: string;
  user_id: string;
  service: string;
}) {
  const { org_id, user_id, service } = params;
  if (!org_id || !user_id || !service) {
    throw new Error("org_id, user_id, service required");
  }

  const supabase = getSupabase();
  const { data } = await supabase
    .from("user_vault")
    .select("status, scopes, last_refreshed_at, last_used_at, created_at")
    .eq("org_id", org_id)
    .eq("user_id", user_id)
    .eq("service", service)
    .single();

  if (!data) {
    return { connected: false, service };
  }

  return {
    connected: data.status === "active",
    service,
    status: data.status,
    scopes: data.scopes,
    connected_at: data.created_at,
    last_used: data.last_used_at,
  };
}

async function revoke(params: {
  org_id: string;
  user_id: string;
  service: string;
}) {
  const { org_id, user_id, service } = params;
  if (!org_id || !user_id || !service) {
    throw new Error("org_id, user_id, service required");
  }

  const supabase = getSupabase();
  const { error: err } = await supabase
    .from("user_vault")
    .update({ status: "revoked", credentials: {} })
    .eq("org_id", org_id)
    .eq("user_id", user_id)
    .eq("service", service);

  if (err) throw new Error(`Revoke failed: ${err.message}`);

  return { revoked: true, service };
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Callback comes as GET redirect from Google
  const url = new URL(req.url);
  if (url.searchParams.get("action") === "callback" || url.searchParams.get("code")) {
    return callback(req);
  }

  try {
    const body = await req.json();
    const { action, ...params } = body;

    let result;
    switch (action) {
      case "authorize":
        result = await authorize(params);
        break;
      case "status":
        result = await status(params);
        break;
      case "revoke":
        result = await revoke(params);
        break;
      default:
        return error(`Unknown action: ${action}. Available: authorize, callback, status, revoke`);
    }

    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});
