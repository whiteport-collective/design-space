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

      const instructions = (data ?? []).map((item: any) => ({
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

    return jsonResponse({ error: `unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
});
