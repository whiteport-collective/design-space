// repo-files: Store and retrieve project files in Agent Space
// Enables /wrap to push design-process/ and /start to pull it back.
//
// Actions:
//   put        — upsert one file
//   put-batch  — upsert many files at once (full folder sync)
//   get        — retrieve one file by project + path
//   list       — list files for a project (optional path_prefix filter)
//   delete     — remove a file

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function client() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action, org_id = "whiteport", project, repo } = body;

    if (!action) return err("action is required");
    if (!project && action !== "list") return err("project is required");

    const db = client();

    // ── PUT ──────────────────────────────────────────────────────────────────
    if (action === "put") {
      const { path, content, content_type = "text/markdown" } = body;
      if (!path) return err("path is required");
      if (content === undefined) return err("content is required");

      const { data, error } = await db
        .from("repo_files")
        .upsert({ org_id, project, repo, path, content, content_type }, {
          onConflict: "org_id,project,path",
        })
        .select("id, path, updated_at")
        .single();

      if (error) throw error;
      return ok({ success: true, file: data });
    }

    // ── PUT-BATCH ────────────────────────────────────────────────────────────
    if (action === "put-batch") {
      const { files } = body;
      if (!Array.isArray(files) || files.length === 0) return err("files array is required");

      const rows = files.map((f: { path: string; content: string; content_type?: string }) => ({
        org_id,
        project,
        repo: repo ?? null,
        path: f.path,
        content: f.content,
        content_type: f.content_type ?? "text/markdown",
      }));

      const { data, error } = await db
        .from("repo_files")
        .upsert(rows, { onConflict: "org_id,project,path" })
        .select("id, path, updated_at");

      if (error) throw error;
      return ok({ success: true, count: data?.length ?? 0, files: data });
    }

    // ── GET ──────────────────────────────────────────────────────────────────
    if (action === "get") {
      const { path } = body;
      if (!path) return err("path is required");

      const { data, error } = await db
        .from("repo_files")
        .select("*")
        .eq("org_id", org_id)
        .eq("project", project)
        .eq("path", path)
        .maybeSingle();

      if (error) throw error;
      if (!data) return err("file not found", 404);
      return ok({ file: data });
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    if (action === "list") {
      const { path_prefix } = body;

      let query = db
        .from("repo_files")
        .select("id, org_id, project, repo, path, content_type, updated_at")
        .eq("org_id", org_id)
        .order("path");

      if (project) query = query.eq("project", project);
      if (repo) query = query.eq("repo", repo);
      if (path_prefix) query = query.like("path", `${path_prefix}%`);

      const { data, error } = await query;
      if (error) throw error;
      return ok({ files: data ?? [], count: data?.length ?? 0 });
    }

    // ── DELETE ───────────────────────────────────────────────────────────────
    if (action === "delete") {
      const { path } = body;
      if (!path) return err("path is required");

      const { error } = await db
        .from("repo_files")
        .delete()
        .eq("org_id", org_id)
        .eq("project", project)
        .eq("path", path);

      if (error) throw error;
      return ok({ success: true });
    }

    return err(`unknown action: ${action}`);

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
