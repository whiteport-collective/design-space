#!/usr/bin/env python3
"""
SessionStart hook: load Agent Space boot data in one round-trip.
Falls back gracefully if session-start is unavailable.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_state import read_state, state_path
from ds_client import AgentSpace

# Fix Windows console encoding
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def print_saved_state(agent_id):
    agent_state = read_state(agent_id)
    if not agent_state:
        return False

    print("\n--- AGENT STATE (auto-loaded) ---")
    print(f"Saved state: {state_path(agent_id)}")
    print("Hej igen! Saved session state found:")
    print(agent_state)
    print("Ska vi fortsatta?")
    print("---\n")
    return True


def load_dotenv():
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def fallback_context(agent_id, project):
    client = AgentSpace(agent_id=agent_id)
    results = client.search(
        "recent agent session activity",
        category="agent_experience",
        limit=7,
        threshold=0.3,
        project=project or None,
    ) or {}
    messages = client.check_messages(limit=5, project=project or None) or {}

    context_results = results.get("results", [])
    unread_messages = messages.get("messages", [])
    if not context_results and not unread_messages:
        return

    print("\n--- AGENT SPACE CONTEXT (fallback) ---")
    if context_results:
        print("\nRecent sessions:")
        for item in context_results[:7]:
            content = item.get("content", "")[:150]
            print(f"  - {content}")

    if unread_messages:
        print(f"\nUnread messages ({len(unread_messages)}):")
        for message in unread_messages:
            meta = message.get("metadata", {})
            from_agent = meta.get("from_agent", "unknown")
            print(f"  [{from_agent}]: {message.get('content', '')[:120]}")
    print("---\n")


def load_context():
    load_dotenv()
    agent_id = os.environ.get("AGENT_ID", "claude-code")
    project = os.environ.get("AGENT_PROJECT", "")
    model_target = os.environ.get("AGENT_MODEL_TARGET") or os.environ.get("AGENT_MODEL") or "claude"
    repo = os.environ.get("AGENT_REPO") or None

    print_saved_state(agent_id)

    try:
        client = AgentSpace(agent_id=agent_id)
        boot = client.session_start(
            project=project or None,
            model_target=model_target,
            repo=repo,
        )
    except Exception:
        boot = None

    if not boot or boot.get("error"):
        fallback_context(agent_id, project)
        return

    instructions = boot.get("instructions", []) or []
    files = boot.get("files", []) or []
    messages = boot.get("messages", []) or []
    state = boot.get("state") or {}

    print("\n--- AGENT SPACE BOOT (auto-loaded) ---")
    print(f"Instruction layers: {len(instructions)}")
    if instructions:
        levels = [item.get("skill_level", "?") for item in instructions]
        print(f"Instruction chain: {' -> '.join(levels)}")
    print(f"Project files: {len(files)}")
    print(f"Unread messages: {len(messages)}")

    if state.get("last_status_report"):
        print("\nSaved remote state:")
        print(f"  {state.get('last_status_report')[:300]}")
    elif state.get("working_on"):
        print("\nSaved remote state:")
        print(f"  Working on: {state.get('working_on')}")

    if messages:
        print("\nUnread messages:")
        for message in messages[:5]:
            meta = message.get("metadata", {})
            from_agent = meta.get("from_agent", "unknown")
            print(f"  [{from_agent}]: {message.get('content', '')[:120]}")

    print("---\n")


if __name__ == "__main__":
    load_context()
