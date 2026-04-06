# Agent Space Audit And Cleanup - 2026-04-05

## What I Found

### Active vs legacy agent-messages actions

- The local codebase no longer actively calls `post-task`, `claim-task`, `list-tasks`, or `update-task`.
- The only active references I found were stale instructions in compiled agent files under `whiteport-design-studio-enterprise-codebase/compiled/claude-sonnet-4-6/`.
- `get-presence` is not called anywhere active in the codebase. The only local reference was the unused `get_presence()` helper in `hooks/ds_client.py`.
- `get-protocol` and `ack-protocol` are not called anywhere active in the current local codebase or command files. Protocol delivery is now happening through `register` and `session-start`.

### Command / boot consistency

- Agent command files (`saga.md`, `freya.md`, `mimir.md`, `idun.md`) already use `session-start`.
- `/start` was still written against the older `agent-messages check` + `repo-files list` flow instead of the unified `session-start` boot response.
- `/wrap` is still aligned with the current `wrap` action and `repo-files put-batch` flow.

### repo-files worker payloads

- Worker compiled files used the correct `repo-files` actions (`get`, `list`, `search`, `section`) but did not document `repo` scoping in worker payloads or request examples.
- Parent compiled files also omitted `repo` in the worker payload examples.

### Embedding coverage

- Recent production data suggests `OPENROUTER_API_KEY` is available for knowledge capture/search:
  knowledge categories created in the last 7 days show non-null embeddings, while `agent_message` remains null by design.
- Even with production apparently configured, several edge functions still hard-failed if `OPENROUTER_API_KEY` was missing:
  `capture-knowledge`, `search-knowledge`, and `search-preference-patterns`.

### Protocol record

- The current live protocol record is `Design Space Protocol v3 - Unified Messaging`, created on 2026-03-20 and updated on 2026-04-05.
- It is now stale relative to current behavior:
  it says nothing is filtered by identity, but current `check()` applies user scoping by default;
  it does not mention `mark-read` dispositions;
  it does not mention `session-start`;
  it still frames the system around older unified-messaging assumptions rather than the current boot flow.

## What I Fixed

### In `c:/dev/WDS/design-space`

- Removed the dead `get_presence()` helper from `hooks/ds_client.py`.
- Updated `database/supabase/functions/repo-files/index.ts` header docs to document optional `repo` scoping on all actions.
- Made `capture-knowledge` tolerate missing/unavailable embeddings instead of failing the whole request.
- Made `search-knowledge` fall back to text search when embeddings are unavailable.
- Made `search-preference-patterns` fall back to text matching when semantic embeddings are unavailable, while still using visual matching if available.
- Updated `C:/Users/marte/.claude/commands/start.md` to use `session-start` and its actual response fields (`boot`, `messages`, `state`, `files`).

### In `c:/dev/WDS/whiteport-design-studio-enterprise-codebase`

- Replaced stale `post-task` references in parent compiled files with the current `send` + `message_type: "work-order"` + `to_agent` pattern.
- Replaced the stale `update-task` reference in `mimir-worker.md` with `update-status`.
- Added `repo` to parent worker payload examples.
- Added `repo` to worker payload examples and to `repo-files` request examples in:
  `freya-worker.md`, `saga-worker.md`, `mimir-worker.md`, `idun-worker.md`.

## What I Left For Human Decision

- The legacy compat actions in `database/supabase/functions/agent-messages/index.ts` still exist in the public API surface.
  I did not remove them in this pass because that is a real API contraction and other live sessions may still depend on them.
- The live protocol record in `agent_space` should be updated, but I left the database record unchanged in this audit pass.
- `README.md` in `design-space` still advertises legacy agent-messages actions. I left it untouched because the repo already has substantial unrelated in-flight edits and I did not want to widen the merge surface further than necessary.

## Recommended Next Step

1. Review whether the legacy compat actions can now be deleted safely.
2. Update the live protocol record to match session-start/user-scoped behavior.
3. If approved, remove the compat actions from `agent-messages` and then clean the remaining outdated README references in the same change.
