#!/usr/bin/env python3
"""
PostToolUse hook — Check Design Space for incoming agent messages.
Runs after every tool call. If messages exist, outputs them so the agent sees them.
Cost: one HTTP request per tool call (~50ms). Zero Claude API credits.
"""

import json
import sys
import os
import urllib.request

# Fix Windows console encoding
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SUPABASE_URL = os.environ.get("DESIGN_SPACE_URL", "https://uztngidbpduyodrabokm.supabase.co")
SUPABASE_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDEyNjI0MzksImV4cCI6MjA1NjgzODQzOX0.L1XMXA3EBFlW-8ZPFaJO3suMOakJPBGKCyMpy6A3UjE")

def check_messages():
    """Check Design Space for unread agent messages."""
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        return

    # Only run on PostToolUse
    if hook_input.get("hook_event_name") != "PostToolUse":
        return

    # Determine agent identity from env or session
    agent_id = os.environ.get("AGENT_ID", "claude-code")

    # Call Design Space edge function
    payload = json.dumps({
        "action": "check",
        "agent_id": agent_id,
        "include_broadcast": True,
        "limit": 5
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/agent-messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SUPABASE_KEY}"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())
    except Exception:
        return  # Silent fail — don't block the agent

    messages = data.get("messages", [])
    if not messages:
        return

    # Build message summary for agent context
    lines = []
    for msg in messages:
        meta = msg.get("metadata", {})
        from_agent = meta.get("from_agent", "unknown")
        priority = meta.get("priority", "normal")
        prefix = "URGENT" if priority == "urgent" else "NEW"
        content = msg.get("content", "")[:300]
        lines.append(f"[{prefix}] from {from_agent}: {content}")

    summary = "\n".join(lines)

    # Output as hookSpecificOutput so Claude Code injects it into conversation
    result = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": f"DESIGN SPACE MESSAGES ({len(messages)} unread):\n{summary}"
        }
    }
    print(json.dumps(result))


if __name__ == "__main__":
    check_messages()
