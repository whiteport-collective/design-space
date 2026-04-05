#!/usr/bin/env python3
"""
wrap-publish — publish a WDS session wrap to Agent Space.

Reads design-process/_progress/session-state.md from the repo,
posts it as a handoff message, and syncs all design-process files.

Usage:
  python wrap-publish.py --repo sharif-webshop --agent freya --user "Mårten Angner"

The script discovers the repo root automatically (walks up from cwd
looking for design-process/). Override with --root if needed.
"""

import argparse, json, os, pathlib, sys, urllib.request, urllib.error

TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dG5naWRicGR1eW9kcmFib2ttIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MTc3ODksImV4cCI6MjA4ODA5Mzc4OX0.FNnTd5p9Qj3WeD0DxQORmNf2jgaVSZ6FU1EGy0W7MRo"
BASE_URL = "https://uztngidbpduyodrabokm.supabase.co/functions/v1"


def post(endpoint: str, payload: dict, timeout: int = 30) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/{endpoint}", data=data,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{endpoint} HTTP {e.code}: {e.read().decode()}") from e


def find_repo_root(start: pathlib.Path) -> pathlib.Path:
    for p in [start, *start.parents]:
        if (p / "design-process").exists():
            return p
    return start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Repo folder name (e.g. sharif-webshop)")
    parser.add_argument("--agent", required=True, help="Agent session id (e.g. freya-2567)")
    parser.add_argument("--user", default=os.environ.get("GIT_AUTHOR_NAME", os.environ.get("USERNAME", "unknown")),
                        help="User id — defaults to git user or system user")
    parser.add_argument("--root", type=pathlib.Path, default=None,
                        help="Repo root. Auto-detected from cwd if omitted.")
    args = parser.parse_args()

    root = args.root.resolve() if args.root else find_repo_root(pathlib.Path.cwd())
    state_file = root / "design-process" / "_progress" / "session-state.md"

    if not state_file.exists():
        print("ERROR: design-process/_progress/session-state.md not found.", file=sys.stderr)
        sys.exit(1)

    state = state_file.read_text(encoding="utf-8")

    # Extract Next: line for working_on
    working_on = ""
    for line in state.splitlines():
        if line.startswith("## Next:"):
            # grab the next non-empty line
            idx = state.splitlines().index(line)
            for follow in state.splitlines()[idx+1:]:
                if follow.strip():
                    working_on = follow.strip()
                    break
            break

    # 1. Post wrap (presence + handoff message)
    result = post("agent-messages", {
        "action": "wrap",
        "agent_id": args.agent,
        "repo": args.repo,
        "user_id": args.user,
        "last_status_report": state,
        "working_on": working_on,
    })
    print(f"Handoff posted: {result.get('handoff_id', '?')}")

    # 2. Sync design-process files
    dp = root / "design-process"
    if not dp.exists():
        print("No design-process/ — skipping file sync.")
        sys.exit(0)

    files = []
    for f in sorted(dp.rglob("*")):
        if f.suffix in (".md", ".yaml", ".yml") and f.is_file():
            rel = f.relative_to(root).as_posix()
            files.append({"path": rel, "content": f.read_text(encoding="utf-8")})

    synced = 0
    for i in range(0, len(files), 50):
        batch = files[i:i+50]
        r = post("repo-files", {
            "action": "put-batch",
            "project": args.repo,
            "org_id": "whiteport",
            "files": batch,
        })
        synced += r.get("count", len(batch))

    print(f"Wrapped. {synced} files synced.")


if __name__ == "__main__":
    main()
