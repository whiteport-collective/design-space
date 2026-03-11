# Codex Agent Workspace

You are working on Design Space, a Supabase-powered backend for cross-LLM agent communication and design knowledge capture.

## Step 0: Use the Codex Scripts

The Codex workflow lives in four stdlib-only Python scripts:

```bash
python agents/codex/session_start.py
python agents/codex/poll_messages.py --once
python agents/codex/capture_insight.py "Decision or discovery"
python agents/codex/session_end.py "Session summary"
```

They load `.env` automatically from the repo root. Never hardcode credentials.

## Step 1: Get Your Task

Your task is posted in Design Space. Use the poller:

```bash
python agents/codex/poll_messages.py --once
```

Read all new messages. Task specifications and thread replies will be printed and written to the local inbox file.

## Step 2: Search for Context

If you need more context about existing patterns or decisions, use the shared client from Python or hit the search endpoint directly. Keep the workflow stdlib-only and repo-local.

## Step 3: Understand the Codebase

```text
design-space/
|-- agents/
|-- supabase/
|   |-- functions/
|   `-- migrations/
|-- mcp-server/
|-- hooks/
|-- jobs/
|-- setup.sh
`-- README.md
```

### Conventions

- Edge functions use the Deno runtime and import from `https://esm.sh/`.
- Match the existing auth and payload patterns before changing APIs.
- SQL migrations are numbered sequentially.
- Embeddings use OpenRouter for text (1536d) and Voyage AI for visuals (1024d).

## Step 4: Report Progress

Capture important progress while you work:

```bash
python agents/codex/capture_insight.py \
  "Decision: chose Python stdlib scripts for Codex Design Space integration" \
  --topics codex,progress
```

Use this for decisions, discoveries, constraints, and handoff notes as they happen. Session-end capture is the backup, not the primary memory path.

## Step 5: Deliver

1. Create a feature branch: `codex/<short-description>`.
2. Make your changes.
3. Open a PR against `main`.
4. Capture the session summary and mark Codex offline:

```bash
python agents/codex/session_end.py "What shipped, what remains, and any risks."
```

## Important

- Read the existing edge functions before writing new ones and match the pattern.
- Credentials are in `.env` (gitignored). Never hardcode them in scripts or docs.
- If anything is unclear, search Design Space first, then ask via `agent-messages`.
