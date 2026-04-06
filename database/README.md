# Database

Agent Space is database-agnostic. This folder contains backend implementations.

## Implementations

| Folder | Backend | Status |
|--------|---------|--------|
| `supabase/` | PostgreSQL + pgvector + Supabase Edge Functions | ✅ Production |

## Adding a New Backend

A backend needs to implement the same core API surface as the Supabase Edge Functions:

- `capture-knowledge` — Store text knowledge with embedding
- `capture-visual` — Store visual captures with dual embeddings
- `capture-feedback-pair` — Linked before/after feedback pairs
- `search-knowledge` — Semantic similarity search
- `search-visual-similarity` — Visual pattern matching
- `search-preference-patterns` — Red flag detection
- `agent-messages` — Full agent messaging (send, check, respond, register, etc.)
- `repo-files` — Store repo-scoped boot files
- `session-start` — Fetch instructions, repo files, messages, and remote state in one call

The MCP server and hooks connect via `DESIGN_SPACE_URL` + `DESIGN_SPACE_ANON_KEY` — swap these env vars to point at a different backend.
