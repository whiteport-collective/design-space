# Job: Design Space Integration for OpenAI Codex

**Commissioner:** Mårten Angner (Whiteport)
**Target:** Any Codex agent
**Repo:** `whiteport-collective/design-space-infrastructure`
**Priority:** Normal

---

## Context

We have a working Design Space — a shared memory for AI agents built on Supabase (PostgreSQL + pgvector). It stores design knowledge, agent experiences, and enables agent-to-agent messaging.

We already have this working for **Claude Code** agents via lifecycle hooks:
- **SessionStart** → load recent experiences + unread messages from Design Space
- **PostToolUse** → check for incoming agent messages (async)
- **Stop** → save a one-sentence session summary to Design Space

See `hooks/` in this repo for the working Claude Code implementation.

## Your Job

Build the equivalent system for **Codex agents**. Codex runs in a sandboxed cloud environment, so the architecture will differ — but the goal is the same:

> Every agent session should **start with awareness** of what other agents did, and **end by sharing** what it accomplished.

## Design Space API

All interaction is via HTTP POST to Supabase Edge Functions. Zero dependencies needed.

**Base URL:** `https://uztngidbpduyodrabokm.supabase.co/functions/v1/`
**Auth:** `Authorization: Bearer <anon-key>` (see `hooks/ds_client.py` for the key)

### Endpoints You Need

| Endpoint | Purpose | Payload |
|----------|---------|---------|
| `capture-design-space` | Save knowledge/experience | `{content, category, designer, topics, source}` |
| `search-design-space` | Semantic search | `{query, category?, limit?, threshold?}` |
| `agent-messages` | Check/send messages | `{action: "check"/"send", agent_id, ...}` |

### Python Client

`hooks/ds_client.py` is a zero-dependency client you can copy directly:

```python
from ds_client import DesignSpace
ds = DesignSpace(agent_id="codex-agent")

# Load context (what happened recently)
results = ds.search("recent agent session activity", category="agent_experience", limit=7)

# Check messages
messages = ds.check_messages()

# Save experience when done
ds.capture(
    "Built Codex integration for Design Space — GitHub Action + wrapper script",
    category="agent_experience",
    topics=["session-log", "codex-agent"]
)

# Send message to another agent
ds.send_message("claude-code", "Codex integration is live, test it!")
```

## Proposed Architecture

Since Codex doesn't have lifecycle hooks like Claude Code, consider:

### Option A: GitHub Action Wrapper
A GitHub Action that wraps Codex runs:
1. **Pre-step:** Fetch recent experiences + messages, inject as context
2. **Codex runs:** Normal Codex execution
3. **Post-step:** Extract summary from Codex output, post to Design Space

### Option B: AGENTS.md / System Prompt Instructions
Add instructions to the repo's `AGENTS.md` telling Codex to:
1. At start: call the search endpoint to load context
2. At end: call the capture endpoint to save what it did
3. Periodically: check for messages

This is simpler but relies on the agent following instructions.

### Option C: Both
Use GitHub Action for reliability + AGENTS.md for interactive awareness.

## Acceptance Criteria

1. A Codex agent can start a session and see what Claude Code agents did recently
2. When a Codex session ends, Claude Code agents can see what Codex did
3. Agents can send messages to each other across platforms (Claude ↔ Codex)
4. Zero external dependencies (stdlib HTTP only, or the provided `ds_client.py`)
5. Works in Codex's sandboxed environment (no global installs, no MCP)

## Deliverables

- [ ] Integration code (Action, wrapper script, or AGENTS.md — your call)
- [ ] Test: post an experience, verify it shows up in `search-design-space`
- [ ] Test: send a message to `claude-code`, verify it shows up in `check_messages`
- [ ] Brief README section explaining the Codex setup

## Constraints

- No pip install — use stdlib `urllib` or copy `ds_client.py`
- No MCP servers — Codex doesn't support them
- Don't modify existing Edge Functions — they already work
- Post your experience to Design Space when you're done (eat your own dog food)

## Reference

- Working Claude Code hooks: `hooks/` in this repo
- Edge Function source: `supabase/functions/` in this repo
- Python client: `hooks/ds_client.py`

---

*This job was written by a Claude Code agent. The irony is not lost on us.*
