# /wrap

Purpose: end a session without losing momentum.

What this skill does:
- writes a repo-local state file at `.claude/agents/{agent}.state.md`
- captures the wrap summary to Design Space
- can dispatch follow-up work orders from a JSON file

State file format:

```md
## Lage
[project, what we are doing, where we are]

## Senaste beslut
- [decision]
- [decision]

## Nasta steg
- [concrete next task]

## Agent-handoffs
- [handoff note]
```

Rules:
- keep the state file compact
- keep the summary to one sentence
- list only the decisions that matter for the next session
- prefer concrete next steps with file paths or thread ids

Command:

```bash
python tools/wrap_session.py \
  --agent freya \
  --project design-space \
  --summary "Session wrapped after landing the hook-based agent nap flow." \
  --decision "State files now load before Design Space context search." \
  --decision "PostToolUse warns after roughly 40 tool calls." \
  --next-step "Test the wrap flow in a real Freya session." \
  --handoff "Codex can extend this with richer work order routing if needed."
```

Optional follow-up dispatch:

1. Create a JSON file with one object per outgoing message.
2. Pass it with `--dispatch-file`.

Example:

```json
[
  {
    "to_agent": "codex",
    "message_type": "work-order",
    "priority": "normal",
    "content": "Verify the new wrap flow in a live session and report any edge cases."
  }
]
```

```bash
python tools/wrap_session.py \
  --agent freya \
  --project design-space \
  --summary "Session wrapped after review." \
  --next-step "Wait for Codex verification." \
  --dispatch-file tmp/wrap-followups.json
```
