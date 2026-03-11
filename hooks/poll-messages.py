#!/usr/bin/env python3
"""
Background poller for Design Space agent messages with exponential backoff.
Polls frequently at first, then backs off: 1m x3, 5m, 10m, 30m, then 1h forever.
Outputs new messages to a file that the PostToolUse hook can pick up.
"""

import json
import os
import sys
import time
import urllib.request

# Force unbuffered output on Windows
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Load credentials
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

SUPABASE_URL = os.environ.get("DESIGN_SPACE_URL", "")
SUPABASE_KEY = os.environ.get("DESIGN_SPACE_ANON_KEY", "")
AGENT_ID = os.environ.get("AGENT_ID", "claude-code")

# Backoff schedule in seconds: 1m x3, 5m, 10m, 30m, then 1h repeating
BACKOFF = [60, 60, 60, 300, 600, 1800, 3600]

# State file for communicating with the hook
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "poll-state.json")


def check_messages():
    payload = json.dumps({
        "action": "check",
        "agent_id": AGENT_ID,
        "include_broadcast": True,
        "limit": 10
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

    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def write_state(messages):
    """Write new messages to state file for the hook to pick up."""
    state = {
        "timestamp": time.time(),
        "messages": messages
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def main():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing DESIGN_SPACE_URL or DESIGN_SPACE_ANON_KEY", file=sys.stderr)
        sys.exit(1)

    print(f"Polling Design Space as '{AGENT_ID}' with exponential backoff...", flush=True)
    print(f"Schedule: {[f'{s}s' for s in BACKOFF]} (last interval repeats)", flush=True)

    poll_count = 0

    while True:
        # Determine sleep interval
        idx = min(poll_count, len(BACKOFF) - 1)
        interval = BACKOFF[idx]

        try:
            data = check_messages()
            messages = data.get("messages", [])

            if messages:
                # Reset backoff on new messages
                poll_count = 0
                print(f"\n[{time.strftime('%H:%M:%S')}] {len(messages)} new message(s):")
                for msg in messages:
                    meta = msg.get("metadata", {})
                    from_agent = meta.get("from_agent", "unknown")
                    content = msg.get("content", "")[:200]
                    print(f"  from {from_agent}: {content}", flush=True)

                write_state(messages)
            else:
                poll_count += 1
                next_label = f"{interval}s" if interval < 60 else f"{interval // 60}m"
                print(f"[{time.strftime('%H:%M:%S')}] No messages. Next poll in {next_label}.", end="\r")

        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] Poll error: {e}", file=sys.stderr)
            poll_count += 1

        time.sleep(interval)


if __name__ == "__main__":
    main()
