#!/usr/bin/env python3
"""Register Codex presence, load Agent Space boot data, and print the current inbox."""

from __future__ import annotations

import argparse
import sys

from design_space import (
    DEFAULT_MODEL,
    DesignSpaceClient,
    DesignSpaceError,
    env_path,
    format_message,
    load_dotenv,
    load_poll_state,
    save_poll_state,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--working-on", help="Current task description for agent presence.")
    parser.add_argument("--workspace", help="Workspace path or label for agent presence.")
    parser.add_argument("--message-limit", type=int, default=10, help="How many recent messages to fetch.")
    parser.add_argument("--project", help="Override project for the boot request.")
    parser.add_argument("--repo", help="Optional repo scope for the boot request.")
    args = parser.parse_args()

    load_dotenv()

    try:
        client = DesignSpaceClient()
        registration = client.register(
            status="online",
            working_on=args.working_on,
            workspace=args.workspace,
            project=args.project or client.config.get("project"),
            repo=args.repo,
        )
        boot = client.session_start(
            project=args.project or client.config.get("project"),
            repo=args.repo,
            model_target=client.config.get("model") or DEFAULT_MODEL,
            message_limit=args.message_limit,
        )
    except DesignSpaceError as exc:
        print(f"Session start failed: {exc}", file=sys.stderr)
        return 1

    print(f"Loaded credentials from: {env_path()}")
    agent = registration.get("agent", {})
    print(f"Registered {agent.get('agent_id', client.agent_id)} as status={agent.get('status', 'unknown')}")

    instructions = boot.get("instructions", []) or []
    files = boot.get("files", []) or []
    messages = boot.get("messages", []) or []
    state = boot.get("state") or {}

    print(f"Instruction layers: {len(instructions)}")
    if instructions:
        levels = [item.get("skill_level", "?") for item in instructions]
        print(f"Instruction chain: {' -> '.join(levels)}")
    print(f"Project files: {len(files)}")
    print(f"Messages available: {len(messages)}")

    if state.get("last_status_report"):
        print(f"Saved state: {state.get('last_status_report')[:240]}")
    elif state.get("working_on"):
        print(f"Saved state: working on {state.get('working_on')}")

    if messages:
        print()
        for message in reversed(messages):
            print(format_message(message))

    poll_state = load_poll_state(client.agent_id)
    seen_ids = poll_state.get("seen_message_ids", [])
    seen_ids.extend(message["id"] for message in messages if message.get("id"))
    poll_state["seen_message_ids"] = seen_ids
    save_poll_state(client.agent_id, poll_state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
