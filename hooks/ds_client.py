"""
Design Space HTTP Client — zero-dependency Python module.

Drop this file into any project. No pip install, no MCP server, no config.
Just import and use.

Usage:
    from ds_client import DesignSpace
    ds = DesignSpace()
    ds.capture("Dark mode works better for dashboards", category="successful_pattern")
    results = ds.search("dashboard patterns")
    ds.send_message("freya", "Review needed on landing page")
    messages = ds.check_messages()
"""

import json
import os
import urllib.request
import sys

# Fix Windows console encoding
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

_DEFAULT_URL = None
_DEFAULT_KEY = None


class DesignSpace:
    """Minimal HTTP client for Design Space. No dependencies beyond stdlib."""

    def __init__(self, url=None, key=None, agent_id=None):
        self.url = url or os.environ.get("DESIGN_SPACE_URL", _DEFAULT_URL)
        self.key = key or os.environ.get("DESIGN_SPACE_ANON_KEY", _DEFAULT_KEY)
        self.agent_id = agent_id or os.environ.get("AGENT_ID", "claude-code")
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.key}"
        }

    def _post(self, function, payload, timeout=5):
        """Post to a Supabase Edge Function. Returns parsed JSON or None."""
        req = urllib.request.Request(
            f"{self.url}/functions/v1/{function}",
            data=json.dumps(payload).encode("utf-8"),
            headers=self.headers,
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except Exception:
            return None

    # --- Knowledge ---

    def capture(self, content, category="general", topics=None, designer=None, source=None):
        """Store knowledge in Design Space."""
        return self._post("capture-design-space", {
            "content": content,
            "category": category,
            "topics": topics or [],
            "designer": designer or self.agent_id,
            "source": source or "http-client"
        })

    def search(self, query, category=None, limit=10, threshold=0.3):
        """Semantic search across Design Space."""
        payload = {"query": query, "limit": limit, "threshold": threshold}
        if category:
            payload["category"] = category
        return self._post("search-design-space", payload)

    # --- Agent Messages ---

    def send_message(self, to_agent, content, message_type="message", priority="normal", thread_id=None):
        """Send a message to another agent."""
        payload = {
            "action": "send",
            "agent_id": self.agent_id,
            "to_agent": to_agent,
            "content": content,
            "message_type": message_type,
            "priority": priority
        }
        if thread_id:
            payload["thread_id"] = thread_id
        return self._post("agent-messages", payload)

    def check_messages(self, include_broadcast=True, limit=5):
        """Check for unread messages."""
        return self._post("agent-messages", {
            "action": "check",
            "agent_id": self.agent_id,
            "include_broadcast": include_broadcast,
            "limit": limit
        }, timeout=3)

    def register(self, name=None, capabilities=None):
        """Register agent presence."""
        return self._post("agent-messages", {
            "action": "register",
            "agent_id": self.agent_id,
            "agent_name": name or self.agent_id,
            "capabilities": capabilities or []
        })

    # --- Visual ---

    def capture_visual(self, description, image_base64=None, category="inspiration"):
        """Store a visual pattern."""
        payload = {
            "description": description,
            "category": category
        }
        if image_base64:
            payload["image"] = image_base64
        return self._post("capture-visual", payload)

    def search_visual(self, query=None, image_base64=None, limit=5):
        """Search for visually similar patterns."""
        payload = {"limit": limit}
        if query:
            payload["query"] = query
        if image_base64:
            payload["image"] = image_base64
        return self._post("search-visual-similarity", payload)
