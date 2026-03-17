#!/usr/bin/env python3
"""
Stop hook — Capture session summary to Design Space when agent finishes.
Stores a one-sentence summary of what the agent did, not the full conversation.
This gives every future agent instant access to what happened across all sessions.
"""

import json
import sys
import os
import urllib.request
from datetime import datetime

# Fix Windows console encoding
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SUPABASE_URL = os.environ.get("DESIGN_SPACE_URL")
SUPABASE_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY")


def capture_experience():
    """Capture session experience to Design Space."""
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    if hook_input.get("hook_event_name") != "Stop":
        return

    agent_id = os.environ.get("AGENT_ID", "claude-code")
    agent_name = os.environ.get("AGENT_NAME", agent_id)
    session_id = hook_input.get("session_id", "unknown")
    stop_reason = hook_input.get("stop_reason", "unknown")

    # The transcript_summary is the key — a concise description of what happened
    # Claude Code provides this in the stop event
    transcript_summary = hook_input.get("transcript_summary", "")

    # Skip empty sessions — no point storing "did nothing"
    if not transcript_summary:
        return

    content = (
        f"[{agent_name} session {datetime.now().strftime('%Y-%m-%d %H:%M')}] "
        f"{transcript_summary}"
    )

    # Post to Design Space as agent_experience
    payload = json.dumps({
        "content": content,
        "category": "agent_experience",
        "designer": agent_name,
        "topics": ["session-log", agent_id],
        "source": "auto-hook",
        "source_file": f"session:{session_id}"
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/capture-design-space",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SUPABASE_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            if data.get("entry"):
                print(f"Experience captured to Design Space: {content[:100]}...")
    except Exception as e:
        print(f"Warning: Could not capture experience: {e}", file=sys.stderr)


if __name__ == "__main__":
    capture_experience()
