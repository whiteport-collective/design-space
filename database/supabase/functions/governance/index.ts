// governance v1: Org governance profile and plugin activation contract
// POST { action: "get-profile" | "put-profile" | "plan-activation" | "activate-plugin" | "deactivate-plugin" | "list-active" }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type CatalogRow = {
  plugin_slug: string;
  display_name: string;
  version: string;
  category: string;
  dependencies: string[] | null;
  default_enabled: boolean;
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

function extractPolicyPlugins(policy: Record<string, unknown>): string[] {
  const pluginPolicy = (policy.plugin_policy ?? {}) as Record<string, unknown>;
  return Object.entries(pluginPolicy)
    .filter(([, value]) => value === "active" || value === true)
    .map(([plugin]) => plugin);
}

function resolveActivationPlan(catalog: CatalogRow[], requested: string[]): CatalogRow[] {
  const bySlug = new Map(catalog.map((row) => [row.plugin_slug, row]));
  const active = new Set<string>();
  const queue = [...new Set(requested)];

  while (queue.length > 0) {
    const slug = queue.shift()!;
    if (active.has(slug)) continue;
    const entry = bySlug.get(slug);
    if (!entry) continue;
    active.add(slug);
    for (const dependency of entry.dependencies ?? []) {
      if (!active.has(dependency)) queue.push(dependency);
    }
  }

  return catalog.filter((row) => active.has(row.plugin_slug));
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

    if (action === "get-profile") {
      const { org_id } = body;
      if (!org_id) {
        return jsonResponse({ error: "org_id is required" }, 400);
      }

      const { data, error } = await client
        .from("org_governance_profiles")
        .select("*")
        .eq("org_id", org_id)
        .maybeSingle();

      if (error) throw error;

      const policy = (data?.policy_json ?? {}) as Record<string, unknown>;
      return jsonResponse({
        profile: data ?? null,
        identity_provider: policy.identity_provider ?? null,
        identity_provider_reason: policy.identity_provider_reason ?? null,
        storage_backend: policy.storage_backend ?? null,
        git_provider: policy.git_provider ?? null,
      });
    }

    if (action === "put-profile") {
      const { org_id } = body;
      if (!org_id) {
        return jsonResponse({ error: "org_id is required" }, 400);
      }

      const { data: existing, error: existingError } = await client
        .from("org_governance_profiles")
        .select("*")
        .eq("org_id", org_id)
        .maybeSingle();

      if (existingError) throw existingError;

      const incomingPolicy = (body.policy_json ?? {}) as Record<string, unknown>;
      const mergedPolicy = body.replace === true
        ? incomingPolicy
        : { ...((existing?.policy_json ?? {}) as Record<string, unknown>), ...incomingPolicy };

      const payload = {
        org_id,
        source_path: (body.source_path as string | undefined) ?? existing?.source_path ?? null,
        raw_document: (body.raw_document as string | undefined) ?? existing?.raw_document ?? null,
        policy_json: mergedPolicy,
        parsed_version: (body.parsed_version as string | undefined) ?? existing?.parsed_version ?? null,
        updated_by: (body.updated_by as string | undefined) ?? existing?.updated_by ?? null,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = existing
        ? await client
          .from("org_governance_profiles")
          .update(payload)
          .eq("org_id", org_id)
          .select("*")
          .single()
        : await client
          .from("org_governance_profiles")
          .insert(payload)
          .select("*")
          .single();

      if (error) throw error;
      return jsonResponse({ profile: data });
    }

    if (action === "plan-activation" || action === "list-active") {
      const { org_id } = body;
      if (!org_id) {
        return jsonResponse({ error: "org_id is required" }, 400);
      }

      const [
        catalogResult,
        profileResult,
        installationsResult,
      ] = await Promise.all([
        client.from("plugin_catalog").select("plugin_slug, display_name, version, category, dependencies, default_enabled").order("plugin_slug"),
        client.from("org_governance_profiles").select("policy_json").eq("org_id", org_id).maybeSingle(),
        client.from("org_plugin_installations").select("plugin_slug, status, config, activated_at").eq("org_id", org_id),
      ]);

      if (catalogResult.error) throw catalogResult.error;
      if (profileResult.error) throw profileResult.error;
      if (installationsResult.error) throw installationsResult.error;

      const catalog = (catalogResult.data ?? []) as CatalogRow[];
      const policy = (profileResult.data?.policy_json ?? {}) as Record<string, unknown>;
      const requestedPlugins = action === "plan-activation"
        ? ((body.requested_plugins as string[] | undefined) ?? extractPolicyPlugins(policy))
        : [];

      const basePlugins = catalog
        .filter((row) => row.default_enabled)
        .map((row) => row.plugin_slug);
      const explicitlyActive = (installationsResult.data ?? [])
        .filter((row: any) => row.status === "active")
        .map((row: any) => row.plugin_slug);

      const plan = resolveActivationPlan(catalog, [...basePlugins, ...explicitlyActive, ...requestedPlugins]);
      const pluginConfigs = new Map(
        (installationsResult.data ?? []).map((row: any) => [row.plugin_slug, row]),
      );

      return jsonResponse({
        org_id,
        requested_plugins: requestedPlugins,
        active_plugins: plan.map((row) => ({
          plugin_slug: row.plugin_slug,
          display_name: row.display_name,
          version: row.version,
          category: row.category,
          dependencies: row.dependencies ?? [],
          source: row.default_enabled
            ? "default"
            : pluginConfigs.get(row.plugin_slug)?.status === "active"
            ? "org_installation"
            : "planned",
          config: pluginConfigs.get(row.plugin_slug)?.config ?? {},
          activated_at: pluginConfigs.get(row.plugin_slug)?.activated_at ?? null,
        })),
      });
    }

    if (action === "activate-plugin") {
      const { org_id, plugin_slug, config = {}, activated_by = null } = body;
      if (!org_id || !plugin_slug) {
        return jsonResponse({ error: "org_id and plugin_slug are required" }, 400);
      }

      const { data: catalog, error: catalogError } = await client
        .from("plugin_catalog")
        .select("plugin_slug, display_name, version, category, dependencies, default_enabled")
        .order("plugin_slug");

      if (catalogError) throw catalogError;

      const plan = resolveActivationPlan(catalog ?? [], [plugin_slug]);
      const activatedAt = new Date().toISOString();
      const rows = plan.map((row) => ({
        org_id,
        plugin_slug: row.plugin_slug,
        status: "active",
        config: row.plugin_slug === plugin_slug ? config : {},
        activated_by,
        activated_at: activatedAt,
      }));

      const { data, error } = await client
        .from("org_plugin_installations")
        .upsert(rows, { onConflict: "org_id,plugin_slug" })
        .select("*");

      if (error) throw error;
      return jsonResponse({ activated: data ?? [], count: data?.length ?? 0 });
    }

    if (action === "deactivate-plugin") {
      const { org_id, plugin_slug } = body;
      if (!org_id || !plugin_slug) {
        return jsonResponse({ error: "org_id and plugin_slug are required" }, 400);
      }

      const { data, error } = await client
        .from("org_plugin_installations")
        .upsert({
          org_id,
          plugin_slug,
          status: "disabled",
          updated_at: new Date().toISOString(),
        }, { onConflict: "org_id,plugin_slug" })
        .select("*")
        .single();

      if (error) throw error;
      return jsonResponse({ installation: data });
    }

    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
