#!/usr/bin/env python3
"""Capture a session summary and mark Codex offline in Design Space."""

from __future__ import annotations

import argparse
import sys
from datetime import datetime

from design_space import DesignSpaceClient, DesignSpaceError, load_dotenv


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summary", nargs="?", help="Session summary text. Falls back to stdin if omitted.")
    parser.add_argument("--skip-capture", action="store_true", help="Only mark the agent offline.")
    args = parser.parse_args()

    summary = args.summary or sys.stdin.read().strip()
    load_dotenv()

    try:
        client = DesignSpaceClient()
        if not args.skip_capture:
            if not summary:
                print("No session summary provided.", file=sys.stderr)
                return 1
            stamped = f"[codex session {datetime.now().strftime('%Y-%m-%d %H:%M')}] {summary}"
            client.capture(
                stamped,
                category="agent_experience",
                topics=["session-log", client.agent_id],
                source="codex-session-end",
            )
        result = client.register(status="offline", working_on="")
    except DesignSpaceError as exc:
        print(f"Session end failed: {exc}", file=sys.stderr)
        return 1

    agent = result.get("agent", {})
    print(f"Agent {agent.get('agent_id', client.agent_id)} marked {agent.get('status', 'offline')}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
