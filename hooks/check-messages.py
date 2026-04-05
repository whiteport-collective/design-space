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
import urllib.request
from pathlib import Path

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SUPABASE_URL = os.environ.get("DESIGN_SPACE_URL", "https://uztngidbpduyodrabokm.supabase.co")
SUPABASE_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTc3ODksImV4cCI6MjA4ODA5Mzc4OX0.FNnTd5p9Qj3WeD0DxQORmNf2jgaVSZ6FU1EGy0W7MRo")
WRAP_WARNING_THRESHOLD = 40


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


def fetch_messages(agent_id, agent_project):
    payload = {
        "action": "check",
        "agent_id": agent_id,
        "limit": 50,
    }
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

    try:
        data = fetch_messages(agent_id, agent_project)
    except Exception:
        data = {}

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

    for msg in new_messages:
        meta = msg.get("metadata", {})
        from_agent = meta.get("from_agent", "unknown")
        signal = msg.get("signal", "available")
        prefix = signal_labels.get(signal, "FYI")
        content = msg.get("content", "")[:200]
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
