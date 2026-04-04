// repo-files: Virtual filesystem over Agent Space repo_files table
// Enables agents and workers to navigate project files without text blobs in spawn payloads.
//
// Actions:
//   put        - upsert one file
//   put-batch  - upsert many files at once
//   get        - retrieve one file by project + path (optional: section to extract a heading)
//   list       - list files for a project (optional: path_prefix, paths_only)
//   search     - text search across file contents (optional: path_prefix, limit)
//   delete     - remove a file
//
// Virtual filesystem semantics:
//   list  → ls    (paths_only:true gives directory tree, default includes content)
//   get   → cat   (section:"Heading Name" extracts one markdown section)
//   search → grep -r (finds files containing query text, returns matching excerpts)

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

function err(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
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

// Extract a named markdown section (## Heading) from content.
// Returns content from the heading line through the next same-or-higher heading (exclusive).
function extractSection(content: string, sectionName: string): string | null {
  const lines = content.split("\n");
  const headingPattern = /^(#{1,6})\s+(.+)$/;

  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingPattern);
    if (!m) continue;
    const level = m[1].length;
    const title = m[2].trim();

    if (startIdx === -1) {
      // Looking for our target heading
      if (title.toLowerCase() === sectionName.toLowerCase()) {
        startIdx = i;
        startLevel = level;
      }
    } else {
      // We're inside the section — stop at same or higher level heading
      if (level <= startLevel) {
        return lines.slice(startIdx, i).join("\n").trim();
      }
    }
  }

  if (startIdx !== -1) {
    // Section runs to end of file
    return lines.slice(startIdx).join("\n").trim();
  }

  return null;
}

// Build a simple excerpt around a match (up to context_chars on each side)
function excerpt(content: string, query: string, contextChars = 200): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(content.length, idx + query.length + contextChars);
  const pre = start > 0 ? "…" : "";
  const post = end < content.length ? "…" : "";
  return pre + content.slice(start, end) + post;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { action, org_id = "whiteport", project } = body;
    const hasRepoScope = body.repo !== undefined && body.repo !== null;
    const repoValue = hasRepoScope ? String(body.repo) : "";

    if (!action) return err("action is required");
    if (!project) return err("project is required");

    const db = client();

    // ── put ─────────────────────────────────────────────────────────────────

    if (action === "put") {
      const { path, content, content_type = "text/markdown" } = body;
      if (!path) return err("path is required");
      if (content === undefined) return err("content is required");

      const { data, error } = await db
        .from("repo_files")
        .upsert({ org_id, project, repo: repoValue, path, content, content_type }, {
          onConflict: "org_id,project,repo,path",
        })
        .select("id, org_id, project, repo, path, content_type, updated_at")
        .single();

      if (error) throw error;
      return ok({ success: true, file: data });
    }

    // ── put-batch ────────────────────────────────────────────────────────────

    if (action === "put-batch") {
      const { files } = body;
      if (!Array.isArray(files) || files.length === 0) return err("files array is required");

      const rows = files.map((file: { path: string; content: string; content_type?: string }) => ({
        org_id,
        project,
        repo: repoValue,
        path: file.path,
        content: file.content,
        content_type: file.content_type ?? "text/markdown",
      }));

      const { data, error } = await db
        .from("repo_files")
        .upsert(rows, { onConflict: "org_id,project,repo,path" })
        .select("id, path, updated_at");

      if (error) throw error;
      return ok({ success: true, count: data?.length ?? 0, files: data ?? [] });
    }

    // ── get ──────────────────────────────────────────────────────────────────
    // cat semantics: fetch one file, optionally extract a named section

    if (action === "get") {
      const { path, section } = body;
      if (!path) return err("path is required");

      let query = db
        .from("repo_files")
        .select("*")
        .eq("org_id", org_id)
        .eq("project", project)
        .eq("path", path);

      if (hasRepoScope) query = query.eq("repo", repoValue);

      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      if (!data) return err("file not found", 404);

      if (section) {
        const extracted = extractSection(data.content, section);
        if (extracted === null) {
          return err(`section "${section}" not found in ${path}`, 404);
        }
        return ok({
          file: { ...data, content: extracted, section },
        });
      }

      return ok({ file: data });
    }

    // ── list ─────────────────────────────────────────────────────────────────
    // ls semantics: list paths (and optionally content) for a project
    // paths_only:true → directory tree only, fast and cheap

    if (action === "list") {
      const { path_prefix, paths_only = false } = body;

      const selectCols = paths_only
        ? "id, path, content_type, updated_at"
        : "id, org_id, project, repo, path, content, content_type, updated_at";

      let query = db
        .from("repo_files")
        .select(selectCols)
        .eq("org_id", org_id)
        .eq("project", project)
        .order("path");

      if (hasRepoScope) query = query.eq("repo", repoValue);
      if (path_prefix) query = query.like("path", `${path_prefix}%`);

      const { data, error } = await query;
      if (error) throw error;
      return ok({ files: data ?? [], count: data?.length ?? 0 });
    }

    // ── search ───────────────────────────────────────────────────────────────
    // grep -r semantics: find files containing query text
    // Returns matching file paths + excerpts around matches

    if (action === "search") {
      const { query: searchQuery, path_prefix, limit = 20, context_chars = 200 } = body;
      if (!searchQuery) return err("query is required");

      let q = db
        .from("repo_files")
        .select("id, path, content, content_type, updated_at")
        .eq("org_id", org_id)
        .eq("project", project)
        .ilike("content", `%${searchQuery}%`)
        .order("path")
        .limit(limit);

      if (hasRepoScope) q = q.eq("repo", repoValue);
      if (path_prefix) q = q.like("path", `${path_prefix}%`);

      const { data, error } = await q;
      if (error) throw error;

      const results = (data ?? []).map((file: Record<string, unknown>) => ({
        path: file.path,
        content_type: file.content_type,
        updated_at: file.updated_at,
        excerpt: excerpt(file.content as string, searchQuery, context_chars),
      }));

      return ok({ results, count: results.length, query: searchQuery });
    }

    // ── delete ───────────────────────────────────────────────────────────────

    if (action === "delete") {
      const { path } = body;
      if (!path) return err("path is required");

      let q = db
        .from("repo_files")
        .delete()
        .eq("org_id", org_id)
        .eq("project", project)
        .eq("path", path);

      if (hasRepoScope) q = q.eq("repo", repoValue);

      const { error } = await q;
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
