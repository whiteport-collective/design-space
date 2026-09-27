#!/usr/bin/env python3
"""
PostToolUse hook: check Design Space for incoming agent messages and session pressure.
Runs after every tool call. If messages or a wrap warning exist, outputs them so the
agent sees them. Cost: one HTTP request per tool call (~50ms).
"""

import json
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SUPABASE_URL = os.environ.get("DESIGN_SPACE_URL", "https://uztngidbpduyodrabokm.supabase.co")
SUPABASE_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY")
if not SUPABASE_KEY:
    # Surface clearly to the agent so it can prompt the user, instead of failing silently.
    # Use a session-counter sentinel so we surface this once per session, not on every tool call.
    sentinel = Path(tempfile.gettempdir()) / "design-space" / "missing-key-warned.flag"
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    if not sentinel.exists():
        sentinel.write_text("warned", encoding="utf-8")
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": (
                    "[AGENT INBOX HOOK DISABLED] DESIGN_SPACE_ANON_KEY env var is missing — "
                    "agent-message inbox checks are NOT running, so handoffs from other agents "
                    "(codex, freya, saga, wera) will not surface automatically. "
                    "Ask the user to either: (a) add the key to ~/.claude/settings.json env section "
                    "and restart Claude Code, or (b) provide it via Bitwarden so it can be set for the session. "
                    "Until then, you must fall back to manual `check`-action polling against the agent-messages edge function."
                )
            }
        }))
    sys.exit(0)
# Tool calls before the wrap reminder. 40 was set for ~200k-token models;
# Opus 5.5 has far more context, so wait much longer.
# Override with DESIGN_SPACE_WRAP_THRESHOLD.
try:
    WRAP_WARNING_THRESHOLD = int(os.environ.get("DESIGN_SPACE_WRAP_THRESHOLD", "300"))
except ValueError:
    WRAP_WARNING_THRESHOLD = 300

# This hook runs after EVERY tool call. Before 2026-09-21 that meant one full
# inbox download per tool call — the single largest source of the 15,25 GB
# egress incident (see EGRESS-INCIDENT-2026-09-18.md). Three things keep it
# cheap now, and all three matter:
#   1. a floor on how often it may call at all (below),
#   2. `since`, so a call fetches only what arrived since the last one,
#   3. `preview`, so content arrives truncated — this hook only ever
#      displays 200 characters per message anyway.
# Override the floor with DESIGN_SPACE_CHECK_INTERVAL (seconds); 0 disables it.
try:
    MIN_CHECK_INTERVAL = int(os.environ.get("DESIGN_SPACE_CHECK_INTERVAL", "60"))
except ValueError:
    MIN_CHECK_INTERVAL = 60

# How much of each message this hook needs to render its one-line summary.
# The server truncates to this before sending; we print what we receive.
PREVIEW_CHARS = 140


def session_counter_path(session_id):
    base = Path(tempfile.gettempdir()) / "design-space" / "tool-counters"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{session_id}.json"


def increment_tool_count(session_id):
    path = session_counter_path(session_id)
    state = {"count": 0, "warned_at": 0}
    if path.exists():
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            state = {"count": 0, "warned_at": 0}

    state["count"] = int(state.get("count", 0)) + 1
    count = state["count"]

    warning = None
    if count >= WRAP_WARNING_THRESHOLD and int(state.get("warned_at", 0)) < WRAP_WARNING_THRESHOLD:
        state["warned_at"] = WRAP_WARNING_THRESHOLD
        warning = f"[SESSION] {count} verktyg anvanda - bra tid att wrappa snart."

    path.write_text(json.dumps(state), encoding="utf-8")
    return count, warning


def cursor_path(session_id):
    return session_counter_path(session_id).parent / f"{session_id}-cursor.json"


def read_cursor(session_id):
    """Last successful check: when it happened and how far it got.

    `since` is the server's checked_at from the previous response, so the next
    call asks only for what arrived after it. It is advanced ONLY on a
    successful fetch — a failed call must not skip the window it missed.
    """
    path = cursor_path(session_id)
    if not path.exists():
        return {"last_check_at": 0.0, "since": None}
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"last_check_at": 0.0, "since": None}
    return {
        "last_check_at": float(state.get("last_check_at", 0.0) or 0.0),
        "since": state.get("since") or None,
    }


def write_cursor(session_id, last_check_at, since):
    try:
        cursor_path(session_id).write_text(
            json.dumps({"last_check_at": last_check_at, "since": since}),
            encoding="utf-8",
        )
    except OSError:
        pass


def fetch_messages(agent_id, agent_project, since=None):
    payload = {
        "action": "check",
        "agent_id": agent_id,
        # Phase 2 (broadcasts) — this hook surfaces headlines, not a mailbox.
        "limit": 20,
        # Phase 1 (direct) is capped server-side too; direct messages are never
        # silently dropped, the response carries has_more_direct when it truncates.
        "direct_limit": 50,
        # Truncate content server-side. We print 200 chars; there is no reason
        # to move the other 3 000 across the wire on every tool call.
        "preview": True,
        "preview_chars": PREVIEW_CHARS,
    }
    if since:
        payload["since"] = since
    if agent_project:
        payload["project"] = agent_project
    # Pass repo + user_id for three-node handoff routing
    repo = os.environ.get("AGENT_REPO", agent_project)
    user_id = os.environ.get("AGENT_USER") or os.environ.get("GIT_AUTHOR_NAME") or os.environ.get("USERNAME")
    if repo:
        payload["repo"] = repo
    if user_id:
        payload["user_id"] = user_id

    request = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/agent-messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SUPABASE_KEY}",
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=3) as response:
        return json.loads(response.read())


def check_messages():
    """Check Design Space for unread agent messages."""
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    if hook_input.get("hook_event_name") != "PostToolUse":
        return

    agent_id = os.environ.get("AGENT_ID", "claude-code")
    agent_project = os.environ.get("AGENT_PROJECT", "")
    session_id = hook_input.get("session_id") or f"{agent_id}-default"
    _, session_warning = increment_tool_count(session_id)

    # Rate floor: this hook fires after every tool call, but the inbox does not
    # change that fast. Inside the floor we skip the network entirely and still
    # let a pending session warning through.
    cursor = read_cursor(session_id)
    now = time.time()
    if MIN_CHECK_INTERVAL > 0 and (now - cursor["last_check_at"]) < MIN_CHECK_INTERVAL:
        if session_warning:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": session_warning,
                }
            }))
        return

    try:
        data = fetch_messages(agent_id, agent_project, since=cursor["since"])
        # Advance the cursor only after a call that actually returned.
        write_cursor(session_id, now, data.get("checked_at") or cursor["since"])
    except Exception:
        data = {}
        # Still record the attempt so a hard-down Agent Space cannot turn every
        # tool call into a blocking 3-second timeout.
        write_cursor(session_id, now, cursor["since"])

    messages = data.get("messages", [])
    if not messages and not session_warning:
        return

    signal_labels = {
        "urgent": "URGENT",
        "strong": "DIRECT+PROJECT",
        "medium": "DIRECT",
        "weak": "PROJECT",
        "available": "FYI",
    }

    # Only surface messages we haven't shown this session
    # Track shown message IDs in a temp file per session
    shown_path = session_counter_path(session_id).parent / f"{session_id}-shown.json"
    shown_ids = set()
    if shown_path.exists():
        try:
            shown_ids = set(json.loads(shown_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            shown_ids = set()

    new_messages = [m for m in messages if m.get("id") not in shown_ids]

    # Update shown IDs
    all_ids = shown_ids | {m.get("id") for m in messages}
    shown_path.write_text(json.dumps(list(all_ids)), encoding="utf-8")

    if not new_messages and not session_warning:
        return

    lines = []
    if session_warning:
        lines.append(session_warning)

    # Phase 1 is capped now. If the cap was hit, say so — a direct message that
    # is merely paginated away must never look like a direct message that does
    # not exist. The agent can fetch the rest with direct_offset.
    if data.get("has_more_direct"):
        lines.append(
            "[INBOX TRUNCATED] Fler direktmeddelanden finns an som visas. "
            f"Hamta resten med action=check, direct_offset={data.get('next_direct_offset')}."
        )

    for msg in new_messages:
        meta = msg.get("metadata", {})
        from_agent = meta.get("from_agent", "unknown")
        signal = msg.get("signal", "available")
        prefix = signal_labels.get(signal, "FYI")
        content = msg.get("content", "")[:PREVIEW_CHARS]
        lines.append(f"[{prefix}] from {from_agent}: {content}")

    if not lines:
        return

    header = f"NEW MESSAGE{'S' if len(new_messages) != 1 else ''} ({len(new_messages)}):"
    result = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": f"{header}\n" + "\n".join(lines),
        }
    }
    print(json.dumps(result))


if __name__ == "__main__":
    check_messages()
