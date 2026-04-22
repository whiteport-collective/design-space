# Security Hardening — Follow-ups

These items were surfaced by the 2026-04-22 comprehensive security audit.
None are currently breaking; they reduce blast radius from credential leaks.

## 1. Edge function caller auth

**Problem:** ~10 edge functions perform writes (including external side effects
to LinkedIn/Facebook via `tool-unipile` and `tool-publer`) but only verify the
Supabase gateway JWT — which is satisfied by the anon key. An attacker with the
anon JWT can forge agent messages, flag knowledge, or spam LinkedIn posts.

**Functions at risk (in rough order of blast radius):**
1. `tool-publer` — posts to LinkedIn/Facebook business pages (external)
2. `tool-unipile` — posts to Mårten's personal LinkedIn + DMs (external)
3. `agent-messages` — can forge messages from any agent
4. `capture-knowledge`, `capture-feedback-pair`, `capture-visual` — pollute knowledge
5. `repo-files`, `agent-instructions`, `governance`, `session-start` — internal writes

**Plan:**
1. Issue API keys for each caller (`identity-access` → `create-api-key`):
   - One per human (Mårten)
   - One per agent identity (claude-code, codex, mimir, freya, saga, ivonne, …)
   - One per CI/automation endpoint
2. Add a shared `_shared/auth.ts` helper that wraps `identity-access.resolve-caller`
   and returns `{ org_id, user_id, auth_mode }`. Reject `legacy_anon` for the 2
   external-side-effect functions. Accept it (temporarily) for internal ones with
   a deprecation warning.
3. Roll out per-function over 1–2 weeks; monitor `tool_usage_log` for 401s.
4. Once all callers are migrated, drop `legacy_anon` support and rotate the
   anon JWT (which has been in committed repos).

**Estimate:** ~1 day of engineering + 1 week of rollout.

## 2. Anon key rotation

The anon JWT ships in repo scripts and docs (cache still visible in git history).
After the API-key migration above completes:
- Rotate the anon key in Supabase dashboard.
- Update `DESIGN_SPACE_ANON_KEY` everywhere it's env-injected.
- Scrub old key from git history (optional — anon keys are designed to be public
  but this one now authorizes writes, so better safe).

## 3. `oauth_state` cleanup job

Table has no TTL. OAuth state tokens are one-shot and should be deleted after use
or after ~10 minutes. Add either:
- A trigger that deletes rows on UPDATE when the flow completes, or
- A `prune_oauth_state()` function similar to `prune_tool_usage_log()`, run daily.

## 4. 55 unused indexes (perf)

The performance advisor flagged 55 unused indexes. These cost write performance
and storage. Review candidates after a month of production workload to confirm
they're actually unused in the slow-query log, then drop in a migration.

## 5. 6× `auth_rls_initplan` perf warnings

On `agent_channel`, `agent_space`, `user_project_access`: policies use
`auth.uid()` directly, causing per-row evaluation. Wrap in `(SELECT auth.uid())`
so Postgres evaluates once per query. Not critical today (tables are small /
service-role bypasses RLS) but will matter at scale.

## 6. `agent_space` duplicate permissive policies

6 pairs of overlapping permissive policies for the same role/command. Consolidate
into one policy per (role, cmd) combination.
