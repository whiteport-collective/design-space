// session-start: Single boot endpoint for WDS agents
// Returns everything an agent needs to start a session in one call.
// Replaces multiple round-trips to separate endpoints.
//
// Request:  { agent_id, project, model_target?, org_id?, client_id?, repo? }
// Response: { instructions, files, messages, presence, session_id }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      agent_id,
      project,
      model_target = "claude",
      org_id = "whiteport",
      client_id,
      repo,
    } = await req.json();

    if (!agent_id) {
      return new Response(JSON.stringify({ error: "agent_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, supabaseKey);

    // ── 1. Resolve skill chain ───────────────────────────────────────────────
    const { data: instructions, error: instrError } = await db.rpc(
      "resolve_agent_instructions",
      {
        p_agent_id: agent_id,
        p_model_target: model_target,
        p_org_id: org_id ?? null,
        p_client_id: client_id ?? null,
        p_project: project ?? null,
        p_repo: repo ?? null,
      },
    );
    if (instrError) console.error("instructions error:", instrError);

    // ── 2. Load project files ────────────────────────────────────────────────
    let files: unknown[] = [];
    if (project) {
      let filesQuery = db
        .from("repo_files")
        .select("path, content, content_type, updated_at")
        .eq("org_id", org_id)
        .eq("project", project)
        .order("path");

      if (repo) filesQuery = filesQuery.eq("repo", repo);

      const { data: fileData, error: filesError } = await filesQuery;
      if (filesError) console.error("files error:", filesError);
      files = fileData ?? [];
    }

    // ── 3. Check unread messages ─────────────────────────────────────────────
    const { data: msgData, error: msgError } = await db
      .from("agent_space")
      .select("id, content, metadata, created_at")
      .or(`metadata->>'to_agent'.eq.${agent_id},metadata->>'to_agent'.is.null`)
      .not("metadata->>'read_by'", "cs", `["${agent_id}"]`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (msgError) console.error("messages error:", msgError);
    const messages = msgData ?? [];

    // ── 4. Get agent presence / saved state ──────────────────────────────────
    const { data: presence } = await db
      .from("agent_presence")
      .select("*")
      .eq("agent_name", agent_id)
      .maybeSingle();

    // ── 5. Auto-register agent presence ─────────────────────────────────────
    let session_id: string | null = null;
    if (agent_id) {
      const sessionCode = Math.floor(1000 + Math.random() * 9000).toString();
      session_id = `${agent_id}-${sessionCode}`;

      await db.from("agent_presence").upsert({
        agent_name: agent_id,
        agent_id: session_id,
        status: "online",
        repo: repo ?? project ?? null,
        last_heartbeat: new Date().toISOString(),
        metadata: { session_code: sessionCode, base_agent_id: agent_id },
      }, { onConflict: "agent_name" });
    }

    // ── Response ─────────────────────────────────────────────────────────────
    return new Response(
      JSON.stringify({
        session_id,
        instructions: instructions ?? [],
        files,
        messages,
        presence,
        summary: {
          instruction_levels: (instructions ?? []).map((i: { skill_level: string }) => i.skill_level),
          file_count: files.length,
          unread_messages: messages.length,
          has_saved_state: !!presence?.working_on,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
