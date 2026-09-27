// agent-instructions: CRUD and resolution API for hierarchical instruction sets
// POST { action: "upsert" | "resolve" | "get" | "delete", ... }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Scope = {
  org_id?: string | null;
  client_id?: string | null;
  project?: string | null;
  repo?: string | null;
  user_id?: string | null;
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function applyNullableScope(query: any, column: string, value: string | null | undefined) {
  return value == null ? query.is(column, null) : query.eq(column, value);
}

function createVersionFromContent(content: string) {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(content)).then((hashBuffer) => {
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return "sha:" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 8);
  });
}

async function findExactInstruction(db: any, body: Record<string, unknown>) {
  let query = db
    .from("agent_instructions")
    .select("*")
    .eq("agent_id", body.agent_id)
    .eq("model_target", body.model_target ?? "claude")
    .eq("skill_level", body.skill_level);

  query = applyNullableScope(query, "org_id", (body.org_id as string | null | undefined) ?? null);
  query = applyNullableScope(query, "client_id", (body.client_id as string | null | undefined) ?? null);
  query = applyNullableScope(query, "project", (body.project as string | null | undefined) ?? null);
  query = applyNullableScope(query, "repo", (body.repo as string | null | undefined) ?? null);
  query = applyNullableScope(query, "user_id", (body.user_id as string | null | undefined) ?? null);

  return await query.maybeSingle();
}

async function findExactSkill(db: any, body: Record<string, unknown>) {
  let query = db
    .from("agent_skills")
    .select("id")
    .eq("skill_slug", body.skill_slug)
    .eq("skill_level", body.skill_level);

  const agentId = (body.agent_id as string | null | undefined) ?? null;
  query = applyNullableScope(query, "agent_id", agentId);
  query = applyNullableScope(query, "org_id", (body.org_id as string | null | undefined) ?? null);
  query = applyNullableScope(query, "client_id", (body.client_id as string | null | undefined) ?? null);
  query = applyNullableScope(query, "project", (body.project as string | null | undefined) ?? null);
  query = applyNullableScope(query, "repo", (body.repo as string | null | undefined) ?? null);

  return await query.maybeSingle();
}

function resolveSkillScopeOrder(skillLevel: string | null | undefined) {
  switch (skillLevel) {
    case "wds_default":
      return 1;
    case "org":
    case "shared":
      return 2;
    case "client":
      return 3;
    case "project":
      return 4;
    case "repo":
      return 5;
    case "user":
      return 6;
    default:
      return 99;
  }
}

function dedupeResolvedSkills(rows: Record<string, unknown>[]) {
  const bySlug = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const slug = typeof row.skill_slug === "string" ? row.skill_slug : null;
    if (!slug) continue;
    bySlug.set(slug, row);
  }

  return [...bySlug.values()].sort((a, b) => {
    const phaseA = typeof a.phase === "number" ? a.phase : Number.MAX_SAFE_INTEGER;
    const phaseB = typeof b.phase === "number" ? b.phase : Number.MAX_SAFE_INTEGER;
    if (phaseA !== phaseB) return phaseA - phaseB;

    const scopeA = resolveSkillScopeOrder((a.skill_level as string | null | undefined) ?? null);
    const scopeB = resolveSkillScopeOrder((b.skill_level as string | null | undefined) ?? null);
    if (scopeA !== scopeB) return scopeA - scopeB;

    return String(a.skill_name ?? a.skill_slug ?? "").localeCompare(
      String(b.skill_name ?? b.skill_slug ?? ""),
    );
  });
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

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (action === "resolve") {
      const {
        agent_id,
        model_target = "claude",
        org_id = null,
        client_id = null,
        project = null,
        repo = null,
        user_id = null,
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const rpcArgs: Record<string, string | null> = {
        p_agent_id: agent_id,
        p_model_target: model_target,
        p_org_id: org_id,
        p_client_id: client_id,
        p_project: project,
        p_repo: repo,
      };
      if (user_id !== null && user_id !== undefined) {
        rpcArgs.p_user_id = user_id;
      }

      const { data, error } = await db.rpc("resolve_agent_instructions", rpcArgs);
      if (error) throw error;

      const instructions = (data ?? [])
        .filter((item: any) => user_id != null || item.user_id == null)
        .map((item: any) => ({
        id: item.id,
        skill_level: item.skill_level,
        content: item.content,
        version: item.version ?? null,
        org_id: item.org_id ?? null,
        client_id: item.client_id ?? null,
        project: item.project ?? null,
        repo: item.repo ?? null,
        user_id: item.user_id ?? null,
        updated_at: item.updated_at,
      }));

      return jsonResponse({ instructions });
    }

    if (action === "upsert") {
      const {
        agent_id,
        model_target = "claude",
        skill_level,
        org_id = null,
        client_id = null,
        project = null,
        repo = null,
        user_id = null,
        content,
        version = null,
      } = body;

      if (!agent_id || !skill_level || !content) {
        return jsonResponse({ error: "agent_id, skill_level, and content are required" }, 400);
      }

      const { data: existing, error: existingError } = await findExactInstruction(db, {
        agent_id,
        model_target,
        skill_level,
        org_id,
        client_id,
        project,
        repo,
        user_id,
      });
      if (existingError) throw existingError;

      if (existing?.id) {
        const { data: updated, error } = await db
          .from("agent_instructions")
          .update({
            content,
            version,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id)
          .select("id")
          .single();
        if (error) throw error;
        return jsonResponse({ success: true, id: updated.id });
      }

      const { data: inserted, error } = await db
        .from("agent_instructions")
        .insert({
          agent_id,
          model_target,
          skill_level,
          org_id,
          client_id,
          project,
          repo,
          user_id,
          content,
          version,
        })
        .select("id")
        .single();
      if (error) throw error;
      return jsonResponse({ success: true, id: inserted.id });
    }

    if (action === "get") {
      const { agent_id, skill_level, model_target = "claude" } = body;
      if (!agent_id || !skill_level) {
        return jsonResponse({ error: "agent_id and skill_level are required" }, 400);
      }

      const { data, error } = await findExactInstruction(db, {
        agent_id,
        model_target,
        skill_level,
        org_id: (body.org_id as string | null | undefined) ?? null,
        client_id: (body.client_id as string | null | undefined) ?? null,
        project: (body.project as string | null | undefined) ?? null,
        repo: (body.repo as string | null | undefined) ?? null,
        user_id: (body.user_id as string | null | undefined) ?? null,
      });
      if (error) throw error;

      return jsonResponse({ instruction: data ?? null });
    }

    if (action === "delete") {
      const { id } = body;
      if (!id) {
        return jsonResponse({ error: "id is required" }, 400);
      }

      const { error } = await db
        .from("agent_instructions")
        .delete()
        .eq("id", id);
      if (error) throw error;

      return jsonResponse({ success: true, id });
    }

    // --- Skill registry actions (agent_skills table) ---

    if (action === "upsert-skill") {
      const {
        agent_id,
        skill_slug,
        skill_name,
        skill_level,
        org_id = null,
        client_id = null,
        project = null,
        repo = null,
        content = null,
        description = null,
      } = body;

      if (!agent_id || !skill_slug || !skill_name || !skill_level) {
        return jsonResponse(
          { error: "agent_id, skill_slug, skill_name, skill_level required" },
          400,
        );
      }

      const { data: existing, error: existingError } = await findExactSkill(db, {
        agent_id,
        skill_slug,
        skill_level,
        org_id,
        client_id,
        project,
        repo,
      });
      if (existingError) throw existingError;

      const explicitVersion = body.version as string | null | undefined;
      let version: string | null = explicitVersion ?? null;
      if (!version && content) {
        version = await createVersionFromContent(content as string);
      }

      const row = {
        agent_id,
        skill_slug,
        skill_name,
        skill_level,
        org_id,
        client_id,
        project,
        repo,
        description,
        content,
        version,
        phase: body.phase ?? null,
      };

      if (existing?.id) {
        const { error } = await db
          .from("agent_skills")
          .update({ ...row, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
        if (error) throw error;
        return jsonResponse({ success: true, id: existing.id, action: "updated" });
      }

      const { data: inserted, error } = await db
        .from("agent_skills")
        .insert(row)
        .select("id")
        .single();
      if (error) throw error;
      return jsonResponse({ success: true, id: inserted.id, action: "inserted" });
    }

    if (action === "get-skill") {
      const { skill_slug, agent_id = null, skill_level = null } = body;
      if (!skill_slug) {
        return jsonResponse({ error: "skill_slug is required" }, 400);
      }

      let query = db
        .from("agent_skills")
        .select("*")
        .eq("skill_slug", skill_slug);
      if (agent_id) query = query.eq("agent_id", agent_id);
      if (skill_level) query = query.eq("skill_level", skill_level);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;

      return jsonResponse({ skill: data ?? null });
    }

    if (action === "resolve-skills") {
      const {
        agent_id,
        org_id = null,
        client_id = null,
        project = null,
        repo = null,
      } = body;

      if (!agent_id) {
        return jsonResponse({ error: "agent_id is required" }, 400);
      }

      const { data, error } = await db.rpc("resolve_agent_skills", {
        p_agent_id: agent_id,
        p_org_id: org_id,
        p_client_id: client_id,
        p_project: project,
        p_repo: repo,
      });
      if (error) throw error;

      const skills = dedupeResolvedSkills(data ?? []).map((item: any) => ({
        id: item.id,
        agent_id: item.agent_id ?? null,
        skill_slug: item.skill_slug,
        skill_name: item.skill_name,
        skill_level: item.skill_level,
        org_id: item.org_id ?? null,
        client_id: item.client_id ?? null,
        project: item.project ?? null,
        repo: item.repo ?? null,
        phase: item.phase ?? null,
        description: item.description ?? null,
        content: item.content ?? null,
        version: item.version ?? null,
        updated_at: item.updated_at,
      }));

      return jsonResponse({ skills });
    }

    if (action === "list-skills") {
      const {
        agent_id = null,
        org_id = null,
        client_id = null,
        project = null,
        repo = null,
        skill_level = null,
      } = body;

      let query = db.from("agent_skills").select("*");

      if (agent_id) query = query.eq("agent_id", agent_id);
      if (org_id) query = query.eq("org_id", org_id);
      if (client_id) query = query.eq("client_id", client_id);
      if (project) query = query.eq("project", project);
      if (repo) query = query.eq("repo", repo);
      if (skill_level) query = query.eq("skill_level", skill_level);

      const { data, error } = await query.order("skill_level").order("skill_slug");
      if (error) throw error;

      return jsonResponse({ skills: data ?? [] });
    }

    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
});
