# Security Posture — Design Space

Last reviewed: 2026-04-22

## Current state

Supabase security + performance advisors return **zero findings** as of the last
audit. All sensitive tables are locked to `service_role`; edge functions bypass
RLS via the service-role key they already hold.

## Recurring audit

- **Trigger:** GitHub Action `.github/workflows/security-audit.yml` runs every
  Monday 06:00 UTC and on `workflow_dispatch`.
- **What it does:** pulls `security` and `performance` advisors from the Supabase
  Management API, renders a markdown report, posts it to Design Space as an
  `audit-report` (clean) or `audit-alert` (has findings) message to `marten`.
- **Secrets required in the repo:**
  - `SUPABASE_ACCESS_TOKEN` — personal access token, Supabase dashboard →
    account → access tokens. Read-only access is sufficient for advisors.
  - `DESIGN_SPACE_ANON_KEY` — same anon JWT used elsewhere; posts to
    `agent-messages` edge function.
- **Exit code:** non-zero if any `ERROR`-level security finding → GitHub marks
  the run red and sends email to repo admins.

## Manual run

```bash
SUPABASE_ACCESS_TOKEN=sbp_... \
SUPABASE_PROJECT_REF=uztngidbpduyodrabokm \
DESIGN_SPACE_URL=https://uztngidbpduyodrabokm.supabase.co \
DESIGN_SPACE_ANON_KEY=eyJ... \
node tools/security-audit.mjs
```

## RLS policy convention

All tables in `public` have:
- `ROW LEVEL SECURITY` enabled.
- A single policy `service_role_full_access` that grants `ALL` to the
  `service_role` role `USING (true) WITH CHECK (true)`.

This means:
- Edge functions (running with the service-role key) have full access — nothing
  changes for them.
- Anon-JWT callers (Supabase PostgREST via anon key) cannot read or write these
  tables directly. They must go through an edge function.
- Authenticated-user callers (Supabase Auth) have no default access. If a use
  case arises, add a narrow second policy for `authenticated` — do not broaden
  the service_role one.

## Known follow-ups

See `docs/follow-ups/security-hardening.md`.
