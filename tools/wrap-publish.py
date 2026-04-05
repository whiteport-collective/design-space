#!/usr/bin/env python3
"""
wrap-publish — publish a WDS session wrap to Agent Space.

The agent writes a session-wrap.md with four sections:
  ## Learned   — knowledge for the organization (→ semantic memory)
  ## Context   — what was done (→ handover + session-state)
  ## Plan      — the ongoing plan and end goal (→ handover)
  ## Next      — single next action on boot (→ boot trigger)

This script handles everything else.

Usage:
  python wrap-publish.py --input session-wrap.md --repo sharif-webshop --agent freya-2567 --user "Mårten Angner"
"""

import argparse, json, os, pathlib, re, sys, urllib.request, urllib.error
from datetime import datetime

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


def parse_sections(text: str) -> dict[str, str]:
    """Parse ## Section headers from markdown, return dict of section name → content."""
    sections = {}
    current = None
    lines = []
    for line in text.splitlines():
        m = re.match(r'^##\s+(.+)', line)
        if m:
            if current:
                sections[current.lower()] = "\n".join(lines).strip()
            current = m.group(1).strip()
            lines = []
        elif current:
            lines.append(line)
    if current:
        sections[current.lower()] = "\n".join(lines).strip()
    return sections


def find_repo_root(start: pathlib.Path) -> pathlib.Path:
    for p in [start, *start.parents]:
        if (p / "design-process").exists():
            return p
    return start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Path to session-wrap.md written by the agent")
    parser.add_argument("--repo", required=True, help="Repo folder name (e.g. sharif-webshop)")
    parser.add_argument("--agent", required=True, help="Agent session id (e.g. freya-2567)")
    parser.add_argument("--user", default=os.environ.get("GIT_AUTHOR_NAME", os.environ.get("USERNAME", "unknown")))
    parser.add_argument("--root", type=pathlib.Path, default=None, help="Repo root. Auto-detected if omitted.")
    args = parser.parse_args()

    input_file = pathlib.Path(args.input)
    if not input_file.exists():
        print(f"ERROR: {args.input} not found.", file=sys.stderr)
        sys.exit(1)

    sections = parse_sections(input_file.read_text(encoding="utf-8"))
    learned = sections.get("learned", "")
    context = sections.get("context", "")
    plan    = sections.get("plan", "")
    next_action = sections.get("next", "").splitlines()[0].strip() if sections.get("next") else ""

    root = args.root.resolve() if args.root else find_repo_root(pathlib.Path.cwd())
    today = datetime.now().strftime("%Y-%m-%d")
    base_agent = re.sub(r'-\d{4}$', '', args.agent)

    # Build full session state (for handover + local file)
    state = f"""# {base_agent} — Session State
**Repo:** {args.repo}
**Wrapped:** {today}

## Context
{context}

## Plan
{plan}

## Next:
{next_action}

## Learned
{learned if learned else 'None'}
"""

    # 1. Write local session-state.md
    dp_progress = root / "design-process" / "_progress"
    if dp_progress.parent.exists():
        dp_progress.mkdir(parents=True, exist_ok=True)
        (dp_progress / "session-state.md").write_text(state, encoding="utf-8")
        print("session-state.md written.")

    # 2. Post wrap → handoff message + presence update
    result = post("agent-messages", {
        "action": "wrap",
        "agent_id": args.agent,
        "repo": args.repo,
        "user_id": args.user,
        "last_status_report": state,
        "working_on": next_action,
    })
    print(f"Handoff posted: {result.get('handoff_id', '?')}")

    # 3. Save learned content to semantic knowledge base
    if learned:
        post("capture-knowledge", {
            "content": f"[{base_agent} · {args.repo} · {today}]\n\n{learned}",
            "category": "agent_experience",
            "project": args.repo,
            "designer": base_agent,
            "topics": ["learned", "session-wrap", base_agent, args.repo],
            "source": "wrap",
        })
        print("Learned content saved to knowledge base.")

    # 4. Sync design-process files
    dp = root / "design-process"
    if not dp.exists():
        print("No design-process/ — skipping file sync.")
    else:
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

        # 5. Append to design-log
        log_file = dp_progress / "design-log.md"
        log_entry = f"\n## {today} {base_agent}\n\n- {next_action}\n"
        if log_file.exists():
            existing = log_file.read_text(encoding="utf-8")
            # Insert after first line (header) if present, else prepend
            lines = existing.splitlines(keepends=True)
            insert_at = 1 if lines else 0
            lines.insert(insert_at, log_entry)
            log_file.write_text("".join(lines), encoding="utf-8")
        else:
            log_file.write_text(f"# Design Log\n{log_entry}", encoding="utf-8")

        print(f"Wrapped. {synced} files synced.")


if __name__ == "__main__":
    main()
