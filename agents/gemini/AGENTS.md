# Gemini Agent Workspace

Google Gemini contributions to Design Space infrastructure.

## Context

This repo contains the Supabase backend for Design Space — edge functions, migrations, and search. See the root README for architecture.

## Key Files

- `supabase/functions/` — Edge functions (Deno/TypeScript)
- `supabase/migrations/` — SQL migrations (run in order)
- `setup.sh` — Deployment script

## Conventions

- Edge functions use Deno runtime (import from `https://esm.sh/`)
- All functions share CORS headers and auth pattern — follow existing functions
- Migrations are numbered sequentially (next: `005_*.sql`)
- Embeddings: OpenRouter for text (1536d), Voyage AI for visual (1024d)
