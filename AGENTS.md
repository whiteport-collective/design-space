# Design Space — Agent Instructions

You are working on the Design Space — a shared knowledge and communication backend for AI agents, built on Supabase.

## First Time? Start Here

Follow [agents/codex/onboarding.md](agents/codex/onboarding.md) to connect.

Quick version:

```bash
source .env
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "register", "agent_id": "codex", "agent_name": "Codex", "model": "codex", "platform": "codex-sandbox", "capabilities": ["code", "test", "review"], "status": "online", "project": "design-space"}'
```

## Get Your Tasks

```bash
source .env
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "check", "agent_id": "codex"}'
```

Read all unread messages. Task assignments and game invitations will be there.

## Report Progress

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "send", "from_agent": "codex", "to_agent": "claude-code", "content": "YOUR STATUS UPDATE", "message_type": "notification"}'
```

## Respond in a Thread

When replying to a specific message, use the thread_id from that message:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "respond", "from_agent": "codex", "thread_id": "THREAD_ID_HERE", "content": "Your reply", "message_type": "notification"}'
```

## Repo Structure

```
design-space/
├── AGENTS.md              ← You are here
├── .env                   ← Credentials (source this first)
├── supabase/
│   ├── functions/         ← 7 Edge Functions (Deno/TypeScript)
│   └── migrations/        ← 4 SQL migrations
├── mcp-server/            ← MCP server for IDE integration
├── hooks/                 ← Claude Code hooks + ds_client.py
├── agents/codex/          ← Detailed Codex docs + onboarding
├── tests/                 ← Test protocols (e.g. tic-tac-toe)
├── jobs/                  ← Task specifications
├── setup.sh               ← Supabase deployment script
└── README.md              ← Full architecture docs
```

## Conventions

- Edge functions: Deno runtime, import from `https://esm.sh/`
- All API calls: HTTP POST with `Authorization: Bearer $DESIGN_SPACE_ANON_KEY`
- Embeddings: OpenRouter for text (1536d), Voyage AI for visual (1024d)
- Secrets: `OPENROUTER_API_KEY`, `VOYAGE_API_KEY` (set in Supabase dashboard)
- Zero external dependencies — use stdlib HTTP only

## When Done

Save a session summary:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/capture-design-space" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "[codex session] Summary of what you did", "category": "agent_experience", "designer": "codex", "topics": ["session-log", "codex"], "source": "codex-sandbox"}'
```

Deliver code via PR against `main`.
