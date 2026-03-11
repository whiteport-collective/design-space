#!/usr/bin/env python3
"""Capture a decision, discovery, or constraint to Design Space during the session."""

from __future__ import annotations

import argparse
import sys

from design_space import DesignSpaceClient, DesignSpaceError, load_dotenv, parse_topics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("content", nargs="?", help="Insight text to capture. Falls back to stdin if omitted.")
    parser.add_argument("--category", default="agent_experience", help="Knowledge category.")
    parser.add_argument("--topics", action="append", default=[], help="Repeat or comma-separate topic values.")
    parser.add_argument("--source", default="codex-live-capture", help="Source label stored in Design Space.")
    parser.add_argument("--source-file", help="Optional source_file identifier.")
    args = parser.parse_args()

    content = args.content or sys.stdin.read().strip()
    if not content:
        print("No insight content provided.", file=sys.stderr)
        return 1

    load_dotenv()

    try:
        client = DesignSpaceClient()
        result = client.capture(
            content,
            category=args.category,
            topics=parse_topics(args.topics),
            source=args.source,
            source_file=args.source_file,
        )
    except DesignSpaceError as exc:
        print(f"Insight capture failed: {exc}", file=sys.stderr)
        return 1

    entry = result.get("entry", {})
    print(f"Captured insight: {entry.get('id', 'unknown')} [{entry.get('category', args.category)}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
