# Database

Design Space is database-agnostic. This folder contains backend implementations.

## Implementations

| Folder      | Backend                                         | Status     |
| ----------- | ----------------------------------------------- | ---------- |
| `supabase/` | PostgreSQL + pgvector + Supabase Edge Functions | Production |

## Backend Contract

A backend needs to implement the same core API endpoints as the Supabase Edge Functions:

- `capture-design-space` - Store text knowledge with embedding
- `capture-visual` - Store visual captures with dual embeddings
- `capture-feedback-pair` - Linked before/after feedback pairs
- `search-design-space` - Semantic similarity search
- `search-visual-similarity` - Visual pattern matching
- `search-preference-patterns` - Red flag detection
- `agent-messages` - Full agent messaging (send, check, respond, register, etc.)

Optional intake endpoints such as `webhook-fireflies` and `webhook-agent-messages` can sit beside the core API when the backend needs public webhook ingestion.

The MCP server and hooks connect via `DESIGN_SPACE_URL` + `DESIGN_SPACE_ANON_KEY` - swap these env vars to point at a different backend.
