# Codex Agent Workspace

You are working on the Design Space infrastructure — a Supabase-powered backend for cross-LLM agent communication and design knowledge capture.

## Step 1: Get Your Task

Your task is posted in Design Space. Fetch it:

```bash
curl -s -X POST https://uztngidbpduyodrabokm.supabase.co/functions/v1/agent-messages \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEyNjI0MzksImV4cCI6MjA1NjgzODQzOX0.L1XMXA3EBFlW-8ZPFaJO3suMOakJPBGKCyMpy6A3UjE" \
  -H "Content-Type: application/json" \
  -d '{"action": "check", "agent_id": "codex"}'
```

Read all unread messages. Your task specification will be there.

## Step 2: Search for Context

If you need more context about existing patterns or decisions, search Design Space:

```bash
curl -s -X POST https://uztngidbpduyodrabokm.supabase.co/functions/v1/search-design-space \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEyNjI0MzksImV4cCI6MjA1NjgzODQzOX0.L1XMXA3EBFlW-8ZPFaJO3suMOakJPBGKCyMpy6A3UjE" \
  -H "Content-Type: application/json" \
  -d '{"query": "your search terms here", "limit": 10}'
```

## Step 3: Understand the Codebase

```
design-space-infrastructure/
├── agents/              ← You are here
├── supabase/
│   ├── functions/       ← Edge functions (Deno/TypeScript)
│   │   ├── agent-messages/index.ts
│   │   ├── capture-design-space/index.ts
│   │   ├── capture-feedback-pair/index.ts
│   │   ├── capture-visual/index.ts
│   │   ├── search-design-space/index.ts
│   │   ├── search-preference-patterns/index.ts
│   │   └── search-visual-similarity/index.ts
│   └── migrations/      ← SQL migrations (numbered, run in order)
│       ├── 001_design_space_table.sql
│       ├── 002_agent_presence_table.sql
│       ├── 003_rls_policies.sql
│       └── 004_search_functions.sql
├── hooks/               ← Python client library (ds_client.py)
├── setup.sh             ← Deployment script
└── README.md            ← Full architecture docs
```

### Conventions

- Edge functions use **Deno runtime** — import from `https://esm.sh/`
- All functions share the same CORS headers and auth pattern — read any existing function as reference
- SQL migrations are numbered sequentially — next available: `005_*.sql`
- Embeddings: OpenRouter for text (1536d), Voyage AI for visual (1024d)
- Environment secrets: `OPENROUTER_API_KEY`, `VOYAGE_API_KEY` (set in Supabase dashboard)

## Step 4: Report Progress

Post status updates back to Design Space as you work:

```bash
curl -s -X POST https://uztngidbpduyodrabokm.supabase.co/functions/v1/agent-messages \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEyNjI0MzksImV4cCI6MjA1NjgzODQzOX0.L1XMXA3EBFlW-8ZPFaJO3suMOakJPBGKCyMpy6A3UjE" \
  -H "Content-Type: application/json" \
  -d '{"action": "send", "from_agent": "codex", "to_agent": "ivo-ops", "content": "YOUR STATUS UPDATE", "message_type": "status", "topics": ["codex", "progress"]}'
```

## Step 5: Deliver

1. Create a feature branch: `codex/<short-description>`
2. Make your changes
3. Open a PR against `main`
4. Post completion message to Design Space (same curl as Step 4, with message_type: "completion")

## Important

- Read the existing edge functions before writing new ones — match the pattern exactly
- The anon key above is public (RLS-protected) — safe to use in agent instructions
- If anything is unclear, search Design Space first, then ask via agent-messages
