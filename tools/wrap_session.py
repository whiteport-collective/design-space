#!/usr/bin/env python3
"""Write repo-local agent state, capture a wrap note, and sync design files to Agent Space."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))

from agent_state import canonical_agent_name, write_state  # noqa: E402


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def build_state(summary: str, decisions: list[str], next_steps: list[str], handoffs: list[str]) -> str:
    sections = [
        ("## Lage", [summary.strip()]),
        ("## Senaste beslut", decisions or ["- Inga nya beslut noterade"]),
        ("## Nasta steg", next_steps or ["- Inget nasta steg angivet"]),
        ("## Agent-handoffs", handoffs or ["- Inga handoffs"]),
    ]

    lines: list[str] = []
    for heading, items in sections:
        lines.append(heading)
        for item in items:
            normalized = item.strip()
            if not normalized:
                continue
            if heading == "## Lage":
                lines.append(normalized)
            elif normalized.startswith("- "):
                lines.append(normalized)
            else:
                lines.append(f"- {normalized}")
        lines.append("")
    return "\n".join(lines).strip()


def post(function_name: str, payload: dict[str, Any], timeout: int = 10) -> dict[str, Any]:
    url = os.environ.get("DESIGN_SPACE_URL", "").rstrip("/")
    key = os.environ.get("DESIGN_SPACE_ANON_KEY", "")
    if not url or not key:
        raise RuntimeError("Missing DESIGN_SPACE_URL or DESIGN_SPACE_ANON_KEY.")

    request = urllib.request.Request(
        f"{url}/functions/v1/{function_name}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{function_name} failed with HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{function_name} failed: {exc.reason}") from exc


def collect_design_process_files(project_root: Path) -> list[dict[str, str]]:
    design_root = project_root / "design-process"
    if not design_root.exists() or not design_root.is_dir():
        return []

    files: list[dict[str, str]] = []
    for path in sorted(design_root.rglob("*.md")):
        relative_path = path.relative_to(project_root).as_posix()
        files.append({
            "path": relative_path,
            "content": path.read_text(encoding="utf-8"),
            "content_type": "text/markdown",
        })
    return files


def push_design_files(project: str, project_root: Path, repo: str | None, org_id: str) -> int:
    files = collect_design_process_files(project_root)
    if not files:
        return 0

    post("repo-files", {
        "action": "put-batch",
        "org_id": org_id,
        "project": project,
        "repo": repo,
        "files": files,
    }, timeout=30)
    return len(files)


def capture_wrap(agent_id: str, project: str, summary: str, state_markdown: str, state_file: Path, source: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    content = (
        f"[{canonical_agent_name(agent_id)} wrap {timestamp}] {summary.strip()}\n\n"
        f"{state_markdown}\n\n"
        f"State file: {state_file}"
    )
    post(
        "capture-knowledge",
        {
            "content": content,
            "category": "agent_experience",
            "project": project or None,
            "designer": canonical_agent_name(agent_id),
            "topics": ["wrap", "session-log", canonical_agent_name(agent_id)],
            "source": source,
            "source_file": f"state:{canonical_agent_name(agent_id)}",
        },
    )


def dispatch_followups(agent_id: str, project: str, dispatch_file: Path | None) -> int:
    if not dispatch_file:
        return 0

    items = json.loads(dispatch_file.read_text(encoding="utf-8"))
    if not isinstance(items, list):
        raise RuntimeError("Dispatch file must contain a JSON list.")

    sent = 0
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError("Each dispatch item must be a JSON object.")
        to_agent = item.get("to_agent")
        content = item.get("content")
        if not to_agent or not content:
            raise RuntimeError("Each dispatch item needs to_agent and content.")

        post(
            "agent-messages",
            {
                "action": "send",
                "from_agent": canonical_agent_name(agent_id),
                "to_agent": to_agent,
                "content": content,
                "message_type": item.get("message_type", "work-order"),
                "priority": item.get("priority", "normal"),
                "project": item.get("project", project or None),
            },
        )
        sent += 1
    return sent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True, help="Agent id or agent name.")
    parser.add_argument("--summary", required=True, help="One-sentence wrap summary.")
    parser.add_argument("--project", default=os.environ.get("AGENT_PROJECT", ""), help="Project name.")
    parser.add_argument("--project-root", type=Path, default=Path.cwd(), help="Project root to scan for design-process/.")
    parser.add_argument("--repo", help="Optional repo name stored with repo_files. Defaults to project-root folder name.")
    parser.add_argument("--org-id", default="whiteport", help="Org id for repo_files writes.")
    parser.add_argument("--decision", action="append", default=[], help="Decision to include in the state file.")
    parser.add_argument("--next-step", action="append", default=[], help="Next step to include in the state file.")
    parser.add_argument("--handoff", action="append", default=[], help="Handoff note to include in the state file.")
    parser.add_argument("--dispatch-file", type=Path, help="Optional JSON file with follow-up Design Space messages.")
    parser.add_argument("--skip-capture", action="store_true", help="Write state only.")
    parser.add_argument("--push-files", dest="push_files", action="store_true", help="Push design-process/*.md into repo_files.")
    parser.add_argument("--no-push-files", dest="push_files", action="store_false", help="Disable design-process sync.")
    parser.add_argument("--source", default="wrap-skill", help="Design Space source label.")
    parser.set_defaults(push_files=None)
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")

    project_root = args.project_root.resolve()
    inferred_project = args.project or project_root.name
    inferred_repo = args.repo or project_root.name
    auto_push = (project_root / "design-process").exists()
    push_files = auto_push if args.push_files is None else args.push_files

    state_markdown = build_state(args.summary, args.decision, args.next_step, args.handoff)
    state_file = write_state(args.agent, state_markdown, root=ROOT)

    capture_error = None
    pushed_file_count = 0
    dispatch_count = 0
    if not args.skip_capture:
        try:
            if push_files:
                pushed_file_count = push_design_files(inferred_project, project_root, inferred_repo, args.org_id)
            capture_wrap(args.agent, inferred_project, args.summary, state_markdown, state_file, args.source)
            dispatch_count = dispatch_followups(args.agent, inferred_project, args.dispatch_file)
        except RuntimeError as exc:
            capture_error = str(exc)

    print(f"State file written: {state_file}")
    if not args.skip_capture and capture_error is None:
        print("Wrap note captured to Agent Space.")
        if push_files:
            print(f"Design files pushed: {pushed_file_count}")
        if dispatch_count:
            print(f"Follow-up messages sent: {dispatch_count}")

    if capture_error:
        print(f"Warning: {capture_error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
