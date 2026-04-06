"""Helpers for repo-local agent nap state files."""

from __future__ import annotations

import re
from pathlib import Path

SESSION_SUFFIX_RE = re.compile(r"^(?P<base>.+)-(?P<suffix>\d+)$")
DEFAULT_MAX_WORDS = 300


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def canonical_agent_name(agent_id: str | None) -> str:
    value = (agent_id or "agent").strip()
    match = SESSION_SUFFIX_RE.match(value)
    if match:
        return match.group("base")
    return value


def state_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / ".claude" / "agents"


def state_path(agent_id: str | None, root: Path | None = None) -> Path:
    return state_dir(root) / f"{canonical_agent_name(agent_id)}.state.md"


def read_state(agent_id: str | None, root: Path | None = None) -> str:
    path = state_path(agent_id, root)
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8").strip()


def trim_words(text: str, limit: int = DEFAULT_MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= limit:
        return text.strip()
    return " ".join(words[:limit]).strip()


def write_state(agent_id: str | None, content: str, root: Path | None = None, limit: int = DEFAULT_MAX_WORDS) -> Path:
    path = state_path(agent_id, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = trim_words(content, limit=limit)
    if normalized and not normalized.endswith("\n"):
        normalized += "\n"
    path.write_text(normalized, encoding="utf-8")
    return path
