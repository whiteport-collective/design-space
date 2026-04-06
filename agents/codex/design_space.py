#!/usr/bin/env python3
"""Stdlib-only Agent Space helpers for Codex workflows."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_AGENT_ID = "codex"
DEFAULT_AGENT_NAME = "Codex"
DEFAULT_MODEL = "codex"
DEFAULT_PLATFORM = "codex-sandbox"
DEFAULT_PROJECT = "design-space"
DEFAULT_CAPABILITIES = ["code", "test", "review"]


class DesignSpaceError(RuntimeError):
    """Raised when the Agent Space API returns an error."""


def script_dir() -> Path:
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return script_dir().parents[1]


def env_path() -> Path:
    return repo_root() / ".env"


def runtime_dir(agent_id: str = DEFAULT_AGENT_ID) -> Path:
    base = Path(tempfile.gettempdir()) / "design-space" / agent_id
    base.mkdir(parents=True, exist_ok=True)
    return base


def state_path(agent_id: str = DEFAULT_AGENT_ID) -> Path:
    return runtime_dir(agent_id) / "poll-state.json"


def inbox_path(agent_id: str = DEFAULT_AGENT_ID) -> Path:
    return runtime_dir(agent_id) / "inbox.txt"


def load_dotenv(path: Path | None = None, override: bool = False) -> Path | None:
    target = path or env_path()
    if not target.exists():
        return None

    for raw_line in target.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if override or key not in os.environ:
            os.environ[key] = value
    return target


def parse_topics(raw_topics: Iterable[str] | None) -> list[str]:
    topics: list[str] = []
    for raw in raw_topics or []:
        for topic in raw.split(","):
            item = topic.strip()
            if item and item not in topics:
                topics.append(item)
    return topics


def default_agent_config() -> dict[str, Any]:
    capabilities = parse_topics([os.environ.get("DESIGN_SPACE_CAPABILITIES", "")])
    return {
        "agent_id": os.environ.get("AGENT_ID", DEFAULT_AGENT_ID),
        "agent_name": os.environ.get("AGENT_NAME", DEFAULT_AGENT_NAME),
        "model": os.environ.get("AGENT_MODEL", DEFAULT_MODEL),
        "platform": os.environ.get("AGENT_PLATFORM", DEFAULT_PLATFORM),
        "project": os.environ.get("AGENT_PROJECT", DEFAULT_PROJECT),
        "framework": os.environ.get("AGENT_FRAMEWORK"),
        "workspace": os.environ.get("AGENT_WORKSPACE"),
        "working_on": os.environ.get("AGENT_WORKING_ON"),
        "capabilities": capabilities or list(DEFAULT_CAPABILITIES),
    }


def load_poll_state(agent_id: str) -> dict[str, Any]:
    path = state_path(agent_id)
    if not path.exists():
        return {"seen_message_ids": [], "poll_step": 0}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"seen_message_ids": [], "poll_step": 0}

    data.setdefault("seen_message_ids", [])
    data.setdefault("poll_step", 0)
    return data


def save_poll_state(agent_id: str, state: dict[str, Any]) -> Path:
    path = state_path(agent_id)
    trimmed_ids = list(dict.fromkeys(state.get("seen_message_ids", [])))[-500:]
    state["seen_message_ids"] = trimmed_ids
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return path


def format_message(message: dict[str, Any]) -> str:
    meta = message.get("metadata", {})
    from_agent = meta.get("from_agent", "unknown")
    message_type = meta.get("message_type", "notification")
    created_at = message.get("created_at", "unknown")
    thread_id = message.get("thread_id", "unknown")
    content = message.get("content", "").strip()
    return (
        f"From: {from_agent}\n"
        f"Type: {message_type}\n"
        f"Thread: {thread_id}\n"
        f"Created: {created_at}\n"
        f"Content:\n{content}\n"
    )


class DesignSpaceClient:
    """Minimal Agent Space HTTP client using urllib only."""

    def __init__(self, *, agent_id: str | None = None) -> None:
        load_dotenv()
        self.config = default_agent_config()
        if agent_id:
            self.config["agent_id"] = agent_id
        self.url = os.environ.get("DESIGN_SPACE_URL", "").rstrip("/")
        self.key = os.environ.get("DESIGN_SPACE_ANON_KEY", "")
        if not self.url or not self.key:
            raise DesignSpaceError("Missing DESIGN_SPACE_URL or DESIGN_SPACE_ANON_KEY in .env or environment.")

    @property
    def agent_id(self) -> str:
        return self.config["agent_id"]

    def _post(self, function_name: str, payload: dict[str, Any], timeout: int = 10) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.url}/functions/v1/{function_name}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise DesignSpaceError(f"{function_name} failed with HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise DesignSpaceError(f"{function_name} request failed: {exc.reason}") from exc

    def search(
        self,
        query: str,
        *,
        category: str | None = None,
        limit: int = 10,
        threshold: float = 0.3,
        project: str | None = None,
        designer: str | None = None,
        include_flagged: bool = False,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "query": query,
            "limit": limit,
            "threshold": threshold,
        }
        if category:
            payload["category"] = category
        if project:
            payload["project"] = project
        if designer:
            payload["designer"] = designer
        if include_flagged:
            payload["include_flagged"] = True
        return self._post("search-knowledge", payload)

    def capture(
        self,
        content: str,
        *,
        category: str = "general",
        topics: Iterable[str] | None = None,
        source: str = "codex-script",
        source_file: str | None = None,
        designer: str | None = None,
        project: str | None = None,
    ) -> dict[str, Any]:
        return self._post(
            "capture-knowledge",
            {
                "content": content,
                "category": category,
                "project": project or self.config.get("project"),
                "designer": designer or self.config.get("agent_name") or self.agent_id,
                "topics": parse_topics(topics),
                "source": source,
                "source_file": source_file,
            },
        )

    def flag_entry(
        self,
        *,
        entry_id: str,
        reason: str,
        superseded_by: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "action": "flag",
            "id": entry_id,
            "reason": reason,
        }
        if superseded_by:
            payload["superseded_by"] = superseded_by
        return self._post("capture-knowledge", payload)

    def check_messages(
        self,
        *,
        include_broadcast: bool = True,
        limit: int = 20,
        project: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "action": "check",
            "agent_id": self.agent_id,
            "include_broadcast": include_broadcast,
            "limit": limit,
        }
        if project:
            payload["project"] = project
        return self._post("agent-messages", payload)

    def thread(self, thread_id: str) -> dict[str, Any]:
        return self._post("agent-messages", {"action": "thread", "thread_id": thread_id})

    def session_start(
        self,
        *,
        project: str | None = None,
        model_target: str | None = None,
        org_id: str = "whiteport",
        client_id: str | None = None,
        repo: str | None = None,
        user_id: str | None = None,
        message_limit: int = 20,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "agent_id": self.agent_id,
            "project": project or self.config.get("project"),
            "model_target": model_target or self.config.get("model") or DEFAULT_MODEL,
            "org_id": org_id,
            "client_id": client_id,
            "repo": repo,
            "message_limit": message_limit,
        }
        if user_id:
            payload["user_id"] = user_id
        return self._post("session-start", payload)

    def put_files(self, *, project: str, files: list[dict[str, Any]], org_id: str = "whiteport", repo: str | None = None) -> dict[str, Any]:
        return self._post(
            "repo-files",
            {
                "action": "put-batch",
                "org_id": org_id,
                "project": project,
                "repo": repo,
                "files": files,
            },
            timeout=30,
        )

    def who_online(self, *, project: str | None = None, capability: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": "who-online"}
        if project:
            payload["project"] = project
        if capability:
            payload["capability"] = capability
        return self._post("agent-messages", payload)

    def mark_read(self, message_ids: Iterable[str]) -> dict[str, Any]:
        return self._post("agent-messages", {"action": "mark-read", "message_ids": list(message_ids), "agent_id": self.agent_id})

    def register(
        self,
        *,
        status: str = "online",
        working_on: str | None = None,
        workspace: str | None = None,
        project: str | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        payload = {
            "action": "register",
            "agent_id": self.agent_id,
            "agent_name": self.config.get("agent_name"),
            "model": self.config.get("model"),
            "platform": self.config.get("platform"),
            "framework": self.config.get("framework"),
            "project": project if project is not None else self.config.get("project"),
            "repo": repo,
            "working_on": working_on if working_on is not None else self.config.get("working_on"),
            "workspace": workspace if workspace is not None else self.config.get("workspace"),
            "capabilities": self.config.get("capabilities") or list(DEFAULT_CAPABILITIES),
            "status": status,
        }
        return self._post("agent-messages", payload)

    def send_message(
        self,
        *,
        to_agent: str,
        content: str,
        message_type: str = "notification",
        priority: str = "normal",
        project: str | None = None,
    ) -> dict[str, Any]:
        return self._post(
            "agent-messages",
            {
                "action": "send",
                "from_agent": self.agent_id,
                "to_agent": to_agent,
                "content": content,
                "message_type": message_type,
                "priority": priority,
                "project": project or self.config.get("project"),
            },
        )

    def respond(
        self,
        *,
        thread_id: str,
        content: str,
        message_type: str = "notification",
    ) -> dict[str, Any]:
        return self._post(
            "agent-messages",
            {
                "action": "respond",
                "from_agent": self.agent_id,
                "thread_id": thread_id,
                "content": content,
                "message_type": message_type,
            },
        )
