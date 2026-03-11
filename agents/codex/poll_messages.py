#!/usr/bin/env python3
"""Poll Design Space messages for Codex with heartbeat refresh and local de-duplication."""

from __future__ import annotations

import argparse
import sys
import time
from typing import Any

from design_space import (
    DesignSpaceClient,
    DesignSpaceError,
    format_message,
    inbox_path,
    load_dotenv,
    load_poll_state,
    save_poll_state,
)

BACKOFF_SECONDS = [60, 60, 60, 300, 600, 1800, 3600]


def write_inbox(client: DesignSpaceClient, messages: list[dict[str, Any]]) -> str:
    target = inbox_path(client.agent_id)
    rendered = "\n" + ("\n" + ("-" * 60) + "\n").join(format_message(msg) for msg in messages)
    target.write_text(rendered.lstrip(), encoding="utf-8")
    return str(target)


def collect_new_messages(client: DesignSpaceClient, state: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    client.register(status="online")
    response = client.check_messages(limit=limit)
    known_ids = set(state.get("seen_message_ids", []))
    messages = list(reversed(response.get("messages", [])))
    new_messages = [message for message in messages if message.get("id") not in known_ids]
    if new_messages:
        state["seen_message_ids"] = state.get("seen_message_ids", []) + [
            message["id"] for message in new_messages if message.get("id")
        ]
        client.mark_read([message["id"] for message in new_messages if message.get("id")])
    return new_messages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Poll only once, then exit.")
    parser.add_argument("--limit", type=int, default=20, help="How many recent messages to fetch per poll.")
    parser.add_argument(
        "--backoff-scale",
        type=float,
        default=1.0,
        help="Multiply the default backoff schedule. Use values < 1.0 for local testing.",
    )
    args = parser.parse_args()

    load_dotenv()

    try:
        client = DesignSpaceClient()
    except DesignSpaceError as exc:
        print(f"Poller startup failed: {exc}", file=sys.stderr)
        return 1

    state = load_poll_state(client.agent_id)
    schedule = [max(1, int(seconds * args.backoff_scale)) for seconds in BACKOFF_SECONDS]

    print(f"Polling as {client.agent_id}. Backoff schedule: {schedule}")
    print(f"Inbox file: {inbox_path(client.agent_id)}")

    while True:
        interval = schedule[min(state.get("poll_step", 0), len(schedule) - 1)]
        try:
            new_messages = collect_new_messages(client, state, args.limit)
            if new_messages:
                state["poll_step"] = 0
                path = write_inbox(client, new_messages)
                print(f"\n[{time.strftime('%H:%M:%S')}] {len(new_messages)} new message(s). Inbox updated at {path}")
                for message in new_messages:
                    print(format_message(message))
            else:
                state["poll_step"] = min(state.get("poll_step", 0) + 1, len(schedule) - 1)
                print(f"[{time.strftime('%H:%M:%S')}] No new messages. Next poll in {interval}s.", flush=True)
            save_poll_state(client.agent_id, state)
        except DesignSpaceError as exc:
            state["poll_step"] = min(state.get("poll_step", 0) + 1, len(schedule) - 1)
            save_poll_state(client.agent_id, state)
            print(f"[{time.strftime('%H:%M:%S')}] Poll failed: {exc}", file=sys.stderr)

        if args.once:
            return 0

        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
