// session-start v3: Single boot call for Agent Space agents with active plugin awareness
//
// Collapses register + instructions + files + messages + state + skills into one call.
// All DB queries run in parallel. No HTTP calls to other edge functions.
//
// Request:
//   agent_id        — required
//   project         — optional, scopes files + messages
//   model_target    — default "claude"
//   org_id          — default "whiteport"
//   client_id       — optional
//   repo            — optional
//   user_id         — optional
//   pronouns        — optional, for registration
//   register        — default true, upserts agent_presence
//   message_limit   — default 50
//
// Response:
//   agent_id        — suffixed instance ID (e.g. "freya-4821")
//   instructions    — compiled instruction content for this agent/model
//   skills          — skill slugs available to this agent at this scope
//   files           — repo files for this project
//   messages        — unread messages, scored by signal strength
//   state           — last known presence/status for this agent
//   online          — other agents currently online
//   protocol        — current protocol content (if not yet acked), else null
//   boot            — { summary, unread_count, next_task }
//   active_plugins  — org-resolved plugin list (best-effort during enterprise rollout)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { MESSAGE_COLUMNS, excludeRead } from "../_shared/columns.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stripSuffix(agentId: string): string {
  return agentId.replace(/(-\d{4}|-[a-f0-9]{6})$/, "");
}

function hasSuffix(agentId: string): boolean {
  return /^.+(-\d{4}|-[a-f0-9]{6})$/.test(agentId);
}

function sessionCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function buildBootSummary(
  agentId: string,
  project: string | null,
  unreadCount: number,
  state: Record<string, unknown> | null,
  online: unknown[],
): { summary: string; unread_count: number; next_task: string | null } {
  const parts: string[] = [];

  parts.push(`${stripSuffix(agentId)} online`);
  if (project) parts.push(project);

  const messagesLine = unreadCount === 0
    ? "no new messages"
    : `${unreadCount} new message${unreadCount === 1 ? "" : "s"}`;
  parts.push(messagesLine);

  const nextTask = (state?.working_on as string) ?? null;
  if (nextTask) {
    parts.push(`next: ${nextTask}`);
    parts.push("continuing");
  } else if (state?.last_status_report) {
    parts.push("resuming from last session");
  } else {
    parts.push("no prior state");
  }

  if (online.length > 0) {
    const names = (online as Array<{ agent_id: string }>)
      .map((a) => a.agent_id)
      .join(", ");
    parts.push(`online: ${names}`);
  }

  return {
    summary: parts.join(" · "),
    unread_count: unreadCount,
    next_task: nextTask,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      agent_id,
      project = null,
      model_target = "claude",
      org_id = "whiteport",
      client_id = null,
      repo = null,
      user_id = null,
      user_email = null,
      pronouns = null,
      register = true,
      message_limit = 50,
      // Cap on unread direct messages returned at boot. Generous, but bounded —
      // an agent with a long inbox must not re-download it on every session start.
      direct_limit = 200,
      // Cap on project files returned at boot; see query 2.
      file_limit = 200,
      resume_token = null,
    } = body;

    if (!agent_id) {
      return json({ error: "agent_id is required" }, 400);
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Compute effective IDs without a DB call
    const alreadySuffixed = hasSuffix(agent_id);
    const code = alreadySuffixed
      ? agent_id.split("-").pop()!
      : (resume_token ?? sessionCode());
    const effectiveId = alreadySuffixed ? agent_id : `${agent_id}-${code}`;
    const baseId = stripSuffix(agent_id);
    const directIds = [effectiveId, baseId];

    const ONLINE_CUTOFF = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    // ── All queries in parallel ─────────────────────────────────────────────

    const [
      instructionsResult,
      skillsResult,
      filesResult,
      presenceResult,
      priorStateResult,
      directMsgsResult,
      otherMsgsResult,
      protocolResult,
      onlineResult,
      pluginCatalogResult,
      installationsResult,
      userProfileResult,
    ] = await Promise.all([

      // 1. Compiled instructions (hierarchical resolution)
      db.rpc("resolve_agent_instructions", {
        p_agent_id: baseId,
        p_model_target: model_target,
        p_org_id: org_id,
        p_client_id: client_id ?? null,
        p_project: project,
        p_repo: repo,
        ...(user_id ? { p_user_id: user_id } : {}),
      }),

      // 2. Skills available to this agent at this scope
      db
        .from("agent_skills")
        .select("skill_slug, skill_name, phase, description")
        .or(`agent_id.eq.${baseId},agent_id.is.null`)
        .order("phase"),

      // 3. Repo files for this project
      project
        ? (() => {
            let q = db
              .from("repo_files")
              .select("path, content, content_type, updated_at, repo")
              .eq("org_id", org_id)
              .eq("project", project)
              .order("path")
              // Bounded on purpose. repo_files.content is arbitrary file text,
              // and this runs on every session start. Unbounded, a project with
              // a few hundred design documents would ship megabytes per boot —
              // the same shape as the 2026-09-18 incident, just a different
              // table. It is empty today; the cap is here so filling it stays
              // cheap. One row beyond the cap is fetched to detect truncation.
              .limit(file_limit + 1);
            if (repo) q = q.eq("repo", repo);
            return q;
          })()
        : Promise.resolve({ data: [], error: null }),

      // 4. Agent presence — upsert (register) or lookup (no register)
      // Note: agent_presence has no project column on remote — scoping is by repo only
      register
        ? db
            .from("agent_presence")
            .upsert(
              {
                org_id,
                agent_id: effectiveId,
                agent_name: baseId,
                model: model_target,
                platform: "claude-code",
                repo,
                pronouns,
                status: "online",
                session_id: crypto.randomUUID(),
                session_start: new Date().toISOString(),
                last_heartbeat: new Date().toISOString(),
                metadata: { base_agent_id: baseId, session_code: code },
              },
              { onConflict: "agent_id" },
            )
            .select()
            .single()
        : db
            .from("agent_presence")
            .select(
              "org_id, agent_id, agent_name, repo, working_on, last_status_report, status, last_heartbeat, metadata",
            )
            .in("agent_id", directIds)
            .order("last_heartbeat", { ascending: false })
            .limit(1)
            .maybeSingle(),

      // 4b. Prior state — most recent presence row for this agent name (across all session IDs)
      // Used for boot summary — the upsert above creates a fresh row, losing working_on/last_status_report
      db
        .from("agent_presence")
        .select("working_on, last_status_report, status, last_heartbeat")
        .eq("agent_name", baseId)
        .not("agent_id", "eq", effectiveId)
        .order("last_heartbeat", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // 5. Direct messages — bounded, read-filtered, never vectors.
      // Previously unbounded with select("*"), which meant every boot pulled
      // the agent's whole history including embedding vector(1536) per row.
      // The cap must not be a silent cut: we fetch one row beyond it purely to
      // detect truncation, then report has_more_direct so a boot that left
      // direct messages behind says so instead of looking complete.
      excludeRead(
        db
          .from("agent_space")
          .select(MESSAGE_COLUMNS)
          .eq("category", "agent_message")
          .in("metadata->>to_agent", directIds),
        directIds,
      )
        .order("created_at", { ascending: false })
        .limit(direct_limit + 1),

      // 6. Broadcast / other messages — limited
      excludeRead(
        db
          .from("agent_space")
          .select(MESSAGE_COLUMNS)
          .eq("category", "agent_message")
          .not("metadata->>to_agent", "in", `(${directIds.map((id) => `"${id}"`).join(",")})`),
        directIds,
      )
        .order("created_at", { ascending: false })
        .limit(message_limit),

      // 7. Protocol — fetch current version for ack check
      db
        .from("agent_space")
        .select("id, content, metadata, created_at, updated_at")
        .eq("category", "protocol")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),

      // 8. Online agents (excluding self)
      db
        .from("agent_presence")
        .select("agent_id, agent_name, pronouns, repo, working_on, last_heartbeat")
        .eq("status", "online")
        .gte("last_heartbeat", ONLINE_CUTOFF)
        .neq("agent_id", effectiveId),

      // 9. Plugin catalog (best-effort; tables may not exist before enterprise migration)
      db
        .from("plugin_catalog")
        .select("plugin_slug, display_name, version, category, dependencies, default_enabled")
        .order("plugin_slug"),

      // 10. Org plugin installations (best-effort; tables may not exist before enterprise migration)
      db
        .from("org_plugin_installations")
        .select("plugin_slug, status, config, activated_at")
        .eq("org_id", org_id),

      // 11. User profile — by user_id or user_email (best-effort; users table may not exist
      //     in legacy installs). Returns at most one row; the most recently updated wins.
      (() => {
        if (!user_id && !user_email) {
          return Promise.resolve({ data: null, error: null });
        }
        let q = db
          .from("users")
          .select("id, email, display_name, preferred_language, agent_preferences, updated_at")
          .eq("org_id", org_id);
        if (user_id) {
          q = q.eq("id", user_id);
        } else if (user_email) {
          q = q.eq("email", user_email);
        }
        return q
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
      })(),
    ]);

    // ── Process results ─────────────────────────────────────────────────────

    if (instructionsResult.error) throw instructionsResult.error;
    if (filesResult.error) throw filesResult.error;

    // Drop the probe row (see query 2) and report truncation rather than
    // letting a partial file set look complete.
    const fileRows = (filesResult.data ?? []) as any[];
    const hasMoreFiles = fileRows.length > file_limit;
    if (hasMoreFiles) fileRows.length = file_limit;
    if (presenceResult.error) throw presenceResult.error;
    if (directMsgsResult.error) throw directMsgsResult.error;

    // Drop the probe row (see query 5) and remember whether it was there.
    const directRows = (directMsgsResult.data ?? []) as any[];
    const hasMoreDirect = directRows.length > direct_limit;
    if (hasMoreDirect) directRows.length = direct_limit;
    if (otherMsgsResult.error) throw otherMsgsResult.error;

    // Extract presence state
    const presenceRow = register
      ? (presenceResult.data as Record<string, unknown>)
      : (presenceResult.data as Record<string, unknown> | null);

    const state = presenceRow
      ? {
          agent_id: presenceRow.agent_id,
          org_id: presenceRow.org_id,
          agent_name: presenceRow.agent_name,
          repo: presenceRow.repo,
          working_on: presenceRow.working_on,
          last_status_report: presenceRow.last_status_report,
          status: presenceRow.status,
          last_heartbeat: presenceRow.last_heartbeat,
          metadata: (presenceRow.metadata as Record<string, unknown>) ?? {},
        }
      : null;

    // Merge and deduplicate messages
    const seen = new Set<string>();
    const allMsgs = [
      ...directRows,
      ...(otherMsgsResult.data ?? []),
    ].filter((m: Record<string, unknown>) => {
      if (seen.has(m.id as string)) return false;
      seen.add(m.id as string);
      return true;
    });

    // Filter: remove already-read and own messages (except handoffs)
    const filtered = allMsgs.filter((m: Record<string, unknown>) => {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      const readBy: string[] = (meta.read_by as string[]) ?? [];
      if (readBy.includes(effectiveId) || readBy.includes(baseId)) return false;
      const fromAgent = meta.from_agent as string | undefined;
      const msgType = meta.message_type as string | undefined;
      if (msgType !== "handoff") {
        if (fromAgent && directIds.includes(fromAgent)) return false;
      }
      return true;
    });

    // Score by signal strength
    const signalOrder: Record<string, number> = { strong: 0, medium: 1, weak: 2, available: 3 };
    const scored = filtered
      .map((m: Record<string, unknown>) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        const toAgent = meta.to_agent as string | undefined;
        const msgProject = m.project as string | undefined;
        const agentMatch = toAgent && directIds.includes(toAgent);
        const projectMatch = project && msgProject === project;
        const signal = agentMatch && projectMatch ? "strong"
          : agentMatch ? "medium"
          : projectMatch ? "weak"
          : "available";
        return { ...m, signal };
      })
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const diff = signalOrder[a.signal as string] - signalOrder[b.signal as string];
        if (diff !== 0) return diff;
        return new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime();
      });

    // Protocol: include content if not yet acked, then auto-ack
    let protocolPayload: { content: string; version: number } | null = null;
    if (protocolResult.data) {
      const proto = protocolResult.data as Record<string, unknown>;
      const meta = (proto.metadata ?? {}) as Record<string, unknown>;
      const readBy: string[] = (meta.read_by as string[]) ?? [];
      const hasRead = readBy.includes(effectiveId) || readBy.includes(baseId);
      if (!hasRead) {
        protocolPayload = {
          content: proto.content as string,
          version: (meta.version as number) ?? 1,
        };
        // Auto-ack: fire-and-forget, don't block the response
        const updatedReadBy = [...readBy, effectiveId];
        db.from("agent_space")
          .update({ metadata: { ...meta, read_by: updatedReadBy } })
          .eq("id", proto.id)
          .then(() => {});
      }
    }

    const activePlugins = pluginCatalogResult.error || installationsResult.error
      ? []
      : (() => {
          const installations = new Map(
            ((installationsResult.data ?? []) as Array<Record<string, unknown>>)
              .map((row) => [row.plugin_slug as string, row]),
          );

          return ((pluginCatalogResult.data ?? []) as Array<Record<string, unknown>>)
            .filter((row) => {
              const installation = installations.get(row.plugin_slug as string);
              return row.default_enabled === true || installation?.status === "active";
            })
            .map((row) => {
              const installation = installations.get(row.plugin_slug as string);
              return {
                plugin_slug: row.plugin_slug,
                display_name: row.display_name,
                version: row.version,
                category: row.category,
                dependencies: row.dependencies ?? [],
                source: row.default_enabled === true ? "default" : "org_installation",
                config: installation?.config ?? {},
                activated_at: installation?.activated_at ?? null,
              };
            });
        })();

    const online = (onlineResult.data ?? []) as Array<{ agent_id: string }>;
    // Use prior state (from previous session) for boot summary — fresh upsert row has no working_on
    const priorState = register
      ? (priorStateResult.data as Record<string, unknown> | null)
      : state;
    const boot = buildBootSummary(effectiveId, project, scored.length, priorState, online);

    // User profile — silent when missing, empty, or table unavailable
    const userProfileRow = userProfileResult?.error
      ? null
      : (userProfileResult?.data as Record<string, unknown> | null);
    const userProfile = (() => {
      if (!userProfileRow) return null;
      const prefs = (userProfileRow.agent_preferences ?? {}) as Record<string, unknown>;
      if (!prefs || Object.keys(prefs).length === 0) return null;
      return {
        user_id: userProfileRow.id,
        email: userProfileRow.email,
        display_name: userProfileRow.display_name,
        preferred_language: userProfileRow.preferred_language,
        agent_preferences: prefs,
        updated_at: userProfileRow.updated_at,
      };
    })();

    const response: Record<string, unknown> = {
      agent_id: effectiveId,
      instructions: instructionsResult.data ?? [],
      skills: skillsResult.data ?? [],
      files: fileRows,
      has_more_files: hasMoreFiles,
      messages: scored,
      // True when this agent has more unread direct messages than the boot
      // payload carries. Never let a capped inbox look like an empty one.
      has_more_direct: hasMoreDirect,
      state,
      online,
      protocol: protocolPayload,
      boot,
      active_plugins: activePlugins,
    };
    if (userProfile) {
      response.user_profile = userProfile;
    }
    return json(response);
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error
      ? e.message
      : (typeof e === "object" && e !== null ? JSON.stringify(e) : String(e));
    return json({ error: msg }, 500);
  }
});
