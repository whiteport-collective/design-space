// identity-access v1: Enterprise identity and API key contract
// POST { action: "resolve-caller" | "get-provider-config" | "upsert-user" | "link-person" | "list-memberships" | "create-api-key" | "revoke-api-key" }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function db() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function findUser(client: any, body: Record<string, unknown>) {
  if (body.id) {
    return await client.from("users").select("*").eq("id", body.id).maybeSingle();
  }

  const orgId = body.org_id as string;
  const externalAuthSubject = body.external_auth_subject as string | undefined;
  const email = body.email as string | undefined;

  if (externalAuthSubject) {
    return await client
      .from("users")
      .select("*")
      .eq("org_id", orgId)
      .eq("external_auth_subject", externalAuthSubject)
      .maybeSingle();
  }

  if (email) {
    return await client
      .from("users")
      .select("*")
      .eq("org_id", orgId)
      .eq("email", email)
      .maybeSingle();
  }

  return { data: null, error: null };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (!action) {
      return jsonResponse({ error: "action is required" }, 400);
    }

    const client = db();

    if (action === "resolve-caller") {
      const token = (body.token as string | undefined) ?? getBearerToken(req);
      if (!token) {
        return jsonResponse({ error: "bearer token or token is required" }, 401);
      }

      const legacyTokens = [
        Deno.env.get("AGENT_SPACE_LEGACY_ANON_KEY"),
        Deno.env.get("DESIGN_SPACE_ANON_KEY"),
        Deno.env.get("SUPABASE_ANON_KEY"),
      ].filter((value): value is string => Boolean(value));

      if (legacyTokens.includes(token)) {
        return jsonResponse({
          org_id: (body.org_id as string | undefined) ?? "whiteport",
          user_id: null,
          auth_mode: "legacy_anon",
          scopes: ["legacy"],
        });
      }

      const keyHash = await hashToken(token);
      const { data: apiKey, error } = await client
        .from("api_keys")
        .select("id, org_id, user_id, scopes, revoked_at, label")
        .eq("key_hash", keyHash)
        .maybeSingle();

      if (error) throw error;
      if (!apiKey || apiKey.revoked_at) {
        return jsonResponse({ error: "invalid or revoked token" }, 401);
      }

      await client
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", apiKey.id);

      return jsonResponse({
        org_id: apiKey.org_id,
        user_id: apiKey.user_id,
        auth_mode: "api_key",
        scopes: apiKey.scopes ?? [],
        api_key_id: apiKey.id,
        label: apiKey.label,
      });
    }

    if (action === "get-provider-config") {
      const { org_id } = body;
      if (!org_id) {
        return jsonResponse({ error: "org_id is required" }, 400);
      }

      const { data, error } = await client
        .from("org_governance_profiles")
        .select("org_id, policy_json, parsed_version, updated_at")
        .eq("org_id", org_id)
        .maybeSingle();

      if (error) throw error;

      const policy = (data?.policy_json ?? {}) as Record<string, unknown>;
      return jsonResponse({
        org_id,
        identity_provider: policy.identity_provider ?? null,
        identity_provider_reason: policy.identity_provider_reason ?? null,
        storage_backend: policy.storage_backend ?? null,
        git_provider: policy.git_provider ?? null,
        policy_json: policy,
        parsed_version: data?.parsed_version ?? null,
        updated_at: data?.updated_at ?? null,
      });
    }

    if (action === "upsert-user") {
      const { org_id, display_name } = body;
      if (!org_id || !display_name) {
        return jsonResponse({ error: "org_id and display_name are required" }, 400);
      }
      if (!body.external_auth_subject && !body.email && !body.id) {
        return jsonResponse({ error: "external_auth_subject, email, or id is required" }, 400);
      }

      const { data: existing, error: existingError } = await findUser(client, body);
      if (existingError) throw existingError;

      const payload = {
        org_id,
        person_id: (body.person_id as string | undefined) ?? existing?.person_id ?? null,
        external_auth_subject: (body.external_auth_subject as string | undefined) ?? existing?.external_auth_subject ?? null,
        user_type: (body.user_type as string | undefined) ?? existing?.user_type ?? "human",
        email: (body.email as string | undefined) ?? existing?.email ?? null,
        display_name,
        avatar_url: (body.avatar_url as string | undefined) ?? existing?.avatar_url ?? null,
        preferred_language: (body.preferred_language as string | undefined) ?? existing?.preferred_language ?? null,
        locale: (body.locale as string | undefined) ?? existing?.locale ?? null,
        role: (body.role as string | undefined) ?? existing?.role ?? null,
        client_type: (body.client_type as string | undefined) ?? existing?.client_type ?? null,
        expertise_areas: (body.expertise_areas as string[] | undefined) ?? existing?.expertise_areas ?? [],
        notification_settings: (body.notification_settings as Record<string, unknown> | undefined) ?? existing?.notification_settings ?? {},
        agent_preferences: (body.agent_preferences as Record<string, unknown> | undefined) ?? existing?.agent_preferences ?? {},
        default_project: (body.default_project as string | undefined) ?? existing?.default_project ?? null,
        default_repo: (body.default_repo as string | undefined) ?? existing?.default_repo ?? null,
        project_access_depth: (body.project_access_depth as string | undefined) ?? existing?.project_access_depth ?? null,
        trust_level: (body.trust_level as Record<string, unknown> | undefined) ?? existing?.trust_level ?? {},
        consent: (body.consent as Record<string, unknown> | undefined) ?? existing?.consent ?? {},
        retention_settings: (body.retention_settings as Record<string, unknown> | undefined) ?? existing?.retention_settings ?? {},
        status: (body.status as string | undefined) ?? existing?.status ?? "active",
        metadata: (body.metadata as Record<string, unknown> | undefined) ?? existing?.metadata ?? {},
        last_seen_at: (body.last_seen_at as string | undefined) ?? existing?.last_seen_at ?? null,
      };

      if (existing?.id) {
        const { data: updated, error } = await client
          .from("users")
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
          .select("*")
          .single();

        if (error) throw error;
        return jsonResponse({ user: updated, created: false });
      }

      const { data: inserted, error } = await client
        .from("users")
        .insert(payload)
        .select("*")
        .single();

      if (error) throw error;
      return jsonResponse({ user: inserted, created: true });
    }

    if (action === "link-person") {
      const { user_id, person_id } = body;
      if (!user_id) {
        return jsonResponse({ error: "user_id is required" }, 400);
      }

      let resolvedPersonId = person_id as string | undefined;
      if (!resolvedPersonId) {
        const displayName = (body.display_name as string | undefined) ?? (body.person?.display_name as string | undefined);
        if (!displayName) {
          return jsonResponse({ error: "person_id or display_name is required" }, 400);
        }

        const { data: person, error } = await client
          .from("people")
          .insert({
            display_name: displayName,
            legal_name: (body.legal_name as string | undefined) ?? (body.person?.legal_name as string | undefined) ?? null,
            primary_email: (body.primary_email as string | undefined) ?? (body.person?.primary_email as string | undefined) ?? null,
            pronouns: (body.pronouns as string | undefined) ?? (body.person?.pronouns as string | undefined) ?? null,
            person_type: (body.person_type as string | undefined) ?? (body.person?.person_type as string | undefined) ?? "human",
            metadata: (body.person_metadata as Record<string, unknown> | undefined) ?? (body.person?.metadata as Record<string, unknown> | undefined) ?? {},
          })
          .select("*")
          .single();

        if (error) throw error;
        resolvedPersonId = person.id;
      }

      const { data: updatedUser, error } = await client
        .from("users")
        .update({ person_id: resolvedPersonId, updated_at: new Date().toISOString() })
        .eq("id", user_id)
        .select("*")
        .single();

      if (error) throw error;

      const { data: person, error: personError } = await client
        .from("people")
        .select("*")
        .eq("id", resolvedPersonId)
        .single();

      if (personError) throw personError;

      return jsonResponse({ user: updatedUser, person });
    }

    if (action === "list-memberships") {
      const { user_id } = body;
      if (!user_id) {
        return jsonResponse({ error: "user_id is required" }, 400);
      }

      const { data, error } = await client
        .from("user_memberships")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return jsonResponse({ memberships: data ?? [], count: data?.length ?? 0 });
    }

    if (action === "create-api-key") {
      const { org_id, label, user_id = null, scopes = [] } = body;
      if (!org_id || !label) {
        return jsonResponse({ error: "org_id and label are required" }, 400);
      }

      const token = `${org_id}.${crypto.randomUUID()}.${crypto.randomUUID().replaceAll("-", "")}`;
      const keyHash = await hashToken(token);

      const { data, error } = await client
        .from("api_keys")
        .insert({
          org_id,
          user_id,
          label,
          key_hash: keyHash,
          scopes,
        })
        .select("id, org_id, user_id, label, scopes, created_at")
        .single();

      if (error) throw error;
      return jsonResponse({
        id: data.id,
        token,
        org_id: data.org_id,
        user_id: data.user_id,
        label: data.label,
        scopes: data.scopes,
        created_at: data.created_at,
      });
    }

    if (action === "revoke-api-key") {
      const { id } = body;
      if (!id) {
        return jsonResponse({ error: "id is required" }, 400);
      }

      const { data, error } = await client
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .select("id, org_id, user_id, label, revoked_at")
        .single();

      if (error) throw error;
      return jsonResponse({ success: true, api_key: data });
    }

    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
