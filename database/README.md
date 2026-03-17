# Database

Design Space is database-agnostic. This folder contains backend implementations.

## Implementations

| Folder | Backend | Status |
|--------|---------|--------|
| `supabase/` | PostgreSQL + pgvector + Supabase Edge Functions | ✅ Production |

## Adding a New Backend

A backend needs to implement the same 7 API endpoints as the Supabase Edge Functions:

- `capture-design-space` — Store text knowledge with embedding
- `capture-visual` — Store visual captures with dual embeddings
- `capture-feedback-pair` — Linked before/after feedback pairs
- `search-design-space` — Semantic similarity search
- `search-visual-similarity` — Visual pattern matching
- `search-preference-patterns` — Red flag detection
- `agent-messages` — Full agent messaging (send, check, respond, register, etc.)

The MCP server and hooks connect via `DESIGN_SPACE_URL` + `DESIGN_SPACE_ANON_KEY` — swap these env vars to point at a different backend.
