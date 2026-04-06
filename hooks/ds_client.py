"""
Agent Space HTTP client: zero-dependency Python module.

Drop this file into any project. No pip install, no MCP server, no config.
Just import and use.
"""

import json
import os
import sys
import urllib.request

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_DEFAULT_URL = None
_DEFAULT_KEY = None


AgentSpace = None  # assigned after class definition for forward compatibility


class DesignSpace:
    """Backward-compatible Agent Space client."""

    def __init__(self, url=None, key=None, agent_id=None):
        self.url = url or os.environ.get("DESIGN_SPACE_URL", _DEFAULT_URL)
        self.key = key or os.environ.get("DESIGN_SPACE_ANON_KEY", _DEFAULT_KEY)
        self.agent_id = agent_id or os.environ.get("AGENT_ID", "claude-code")
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.key}",
        }

    def _post(self, function, payload, timeout=5):
        request = urllib.request.Request(
            f"{self.url}/functions/v1/{function}",
            data=json.dumps(payload).encode("utf-8"),
            headers=self.headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except Exception:
            return None

    # --- Knowledge ---

    def capture(self, content, category="general", topics=None, designer=None, source=None, project=None, source_file=None):
        return self._post("capture-knowledge", {
            "content": content,
            "category": category,
            "topics": topics or [],
            "designer": designer or self.agent_id,
            "source": source or "http-client",
            "project": project,
            "source_file": source_file,
        })

    def flag(self, entry_id, reason, superseded_by=None):
        payload = {"action": "flag", "id": entry_id, "reason": reason}
        if superseded_by:
            payload["superseded_by"] = superseded_by
        return self._post("capture-knowledge", payload)

    def search(self, query, category=None, limit=10, threshold=0.3, project=None, designer=None, include_flagged=False):
        payload = {"query": query, "limit": limit, "threshold": threshold}
        if category:
            payload["category"] = category
        if project:
            payload["project"] = project
        if designer:
            payload["designer"] = designer
        if include_flagged:
            payload["include_flagged"] = True
        return self._post("search-knowledge", payload)

    # --- Agent Messages ---

    def send_message(self, to_agent, content, message_type="message", priority="normal", thread_id=None, project=None):
        payload = {
            "action": "send",
            "from_agent": self.agent_id,
            "to_agent": to_agent,
            "content": content,
            "message_type": message_type,
            "priority": priority,
            "project": project,
        }
        if thread_id:
            payload["thread_id"] = thread_id
        return self._post("agent-messages", payload)

    def check_messages(self, include_broadcast=True, limit=5, project=None):
        payload = {
            "action": "check",
            "agent_id": self.agent_id,
            "include_broadcast": include_broadcast,
            "limit": limit,
        }
        if project:
            payload["project"] = project
        return self._post("agent-messages", payload, timeout=3)

    def register(self, name=None, capabilities=None, project=None, repo=None):
        payload = {
            "action": "register",
            "agent_id": self.agent_id,
            "agent_name": name or self.agent_id,
            "capabilities": capabilities or [],
        }
        if project:
            payload["project"] = project
        if repo:
            payload["repo"] = repo
        return self._post("agent-messages", payload)

    # --- Visual ---

    def capture_visual(self, description, image_base64=None, category="inspiration"):
        payload = {
            "description": description,
            "category": category,
        }
        if image_base64:
            payload["image"] = image_base64
        return self._post("capture-visual", payload)

    def search_visual(self, query=None, image_base64=None, limit=5):
        payload = {"limit": limit}
        if query:
            payload["query"] = query
        if image_base64:
            payload["image"] = image_base64
        return self._post("search-visual-similarity", payload)

    # --- Repo Files ---

    def put_file(self, project, path, content, org_id="whiteport", repo=None, content_type="text/markdown"):
        return self._post("repo-files", {
            "action": "put",
            "org_id": org_id,
            "project": project,
            "repo": repo,
            "path": path,
            "content": content,
            "content_type": content_type,
        })

    def put_files(self, project, files, org_id="whiteport", repo=None):
        return self._post("repo-files", {
            "action": "put-batch",
            "org_id": org_id,
            "project": project,
            "repo": repo,
            "files": files,
        })

    def get_file(self, project, path, org_id="whiteport"):
        return self._post("repo-files", {
            "action": "get",
            "org_id": org_id,
            "project": project,
            "path": path,
        })

    def list_files(self, project, path_prefix=None, org_id="whiteport", repo=None):
        payload = {
            "action": "list",
            "org_id": org_id,
            "project": project,
            "repo": repo,
        }
        if path_prefix:
            payload["path_prefix"] = path_prefix
        return self._post("repo-files", payload)

    # --- Session Start ---

    def session_start(self, agent_id=None, project=None, model_target="claude", org_id="whiteport", client_id=None, repo=None, user_id=None, message_limit=20):
        payload = {
            "agent_id": agent_id or self.agent_id,
            "project": project,
            "model_target": model_target,
            "org_id": org_id,
            "client_id": client_id,
            "repo": repo,
            "message_limit": message_limit,
        }
        if user_id:
            payload["user_id"] = user_id
        return self._post("session-start", payload, timeout=10)


AgentSpace = DesignSpace
