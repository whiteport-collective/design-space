#!/usr/bin/env python3
"""Register Codex presence, load context, and print current Design Space inbox."""

from __future__ import annotations

import argparse
import sys
from typing import Any

from design_space import (
    DesignSpaceClient,
    DesignSpaceError,
    env_path,
    format_message,
    load_dotenv,
    load_poll_state,
    save_poll_state,
)


def print_results(title: str, results: list[dict[str, Any]], limit: int) -> None:
    if not results:
        print(f"{title}: none")
        return

    print(f"{title}:")
    for item in results[:limit]:
        content = item.get("content", "").strip().replace("\n", " ")
        print(f"- {content[:160]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--working-on", help="Current task description for agent presence.")
    parser.add_argument("--workspace", help="Workspace path or label for agent presence.")
    parser.add_argument("--message-limit", type=int, default=10, help="How many recent messages to check.")
    parser.add_argument("--context-limit", type=int, default=5, help="How many context results to print per search.")
    args = parser.parse_args()

    load_dotenv()

    try:
        client = DesignSpaceClient()
        registration = client.register(status="online", working_on=args.working_on, workspace=args.workspace)
        context = client.search(
            "recent agent session activity, decisions, constraints, and handoff notes",
            category="agent_experience",
            limit=args.context_limit,
            threshold=0.25,
        )
        constraints = client.search(
            "constraint rejection preference requirement",
            category="client_feedback",
            limit=args.context_limit,
            threshold=0.2,
        )
        message_data = client.check_messages(limit=args.message_limit)
    except DesignSpaceError as exc:
        print(f"Session start failed: {exc}", file=sys.stderr)
        return 1

    print(f"Loaded credentials from: {env_path()}")
    agent = registration.get("agent", {})
    print(f"Registered {agent.get('agent_id', client.agent_id)} as status={agent.get('status', 'unknown')}")

    print_results("Recent agent context", context.get("results", []), args.context_limit)
    print_results("Client constraints", constraints.get("results", []), args.context_limit)

    messages = message_data.get("messages", [])
    print(f"Messages available: {len(messages)}")
    if messages:
        print()
        for message in reversed(messages):
            print(format_message(message))

    state = load_poll_state(client.agent_id)
    seen_ids = state.get("seen_message_ids", [])
    seen_ids.extend(message["id"] for message in messages if message.get("id"))
    state["seen_message_ids"] = seen_ids
    save_poll_state(client.agent_id, state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
