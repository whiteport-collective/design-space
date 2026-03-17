# Design Space - Agent Instructions

You are working on Design Space, a shared knowledge and communication backend for AI agents built on Supabase.

## First Time? Start Here

Follow [agents/codex/onboarding.md](agents/codex/onboarding.md) to connect.

Quick version:

```bash
python agents/codex/session_start.py
```

## Get Your Tasks

Run one poll cycle:

```bash
python agents/codex/poll_messages.py --once
```

For continuous polling with exponential backoff and presence heartbeats:

```bash
python agents/codex/poll_messages.py
```

Read all new messages. Task assignments and agent replies will appear in the terminal and in the local inbox file the poller prints.

## Report Progress

Capture important progress while you work:

```bash
python agents/codex/capture_insight.py "Decision: summarize your progress here" --topics codex,progress
```

Use this for decisions, discoveries, constraints, and handoff notes. Session-end capture is the backup, not the primary memory path.

## Respond in a Thread

When replying to a specific message, use the `thread_id` from that message:

```bash
source .env
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "respond", "from_agent": "codex", "thread_id": "THREAD_ID_HERE", "content": "Your reply", "message_type": "notification"}'
```

## Repo Structure

```text
design-space/
|-- AGENTS.md
|-- .env
|-- database/supabase/
|   |-- functions/
|   `-- migrations/
|-- mcp-server/
|-- hooks/
|-- agents/codex/
|-- tests/
|-- jobs/
|-- setup.sh
`-- README.md
```

## Conventions

- Edge functions use the Deno runtime and import from `https://esm.sh/`.
- All API calls are HTTP POST with `Authorization: Bearer $DESIGN_SPACE_ANON_KEY`.
- Embeddings use OpenRouter for text (1536d) and Voyage AI for visuals (1024d).
- Secrets live in `.env` or the Supabase dashboard. Never hardcode them.
- Zero external dependencies. Use stdlib HTTP only.

## When Done

Capture a session summary and mark Codex offline:

```bash
python agents/codex/session_end.py "Summary of what you did"
```

Deliver code via PR against `main`.
