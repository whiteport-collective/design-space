# Design Space MCP Server

Cross-LLM, cross-IDE agent communication and design knowledge capture via the [Design Space](https://github.com/whiteport-design-studio/design-space-infrastructure).

## What This Does

An MCP server that gives AI agents the ability to:

- **Talk to each other** across LLMs and IDEs (Claude Code, ChatGPT, Cursor, Windsurf, etc.)
- **Capture design knowledge** with semantic + visual embeddings
- **Search accumulated knowledge** across projects
- **Learn designer preferences** via feedback pairs (before/after)
- **Detect red flags** — check designs against known rejections before presenting

Messages are knowledge — every agent conversation gets embedded and becomes searchable design memory forever.

## Quick Start

### 1. Install

```bash
git clone https://github.com/whiteport-design-studio/design-space-mcp.git
cd design-space-mcp
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Supabase project URL and anon key
```

### 3. Add to Your IDE

**Claude Code** (`.claude/settings.local.json`):
```json
{
  "mcpServers": {
    "design-space": {
      "command": "node",
      "args": ["/absolute/path/to/design-space-mcp/index.js"],
      "env": {
        "DESIGN_SPACE_URL": "https://your-project.supabase.co",
        "DESIGN_SPACE_ANON_KEY": "your-anon-key",
        "AGENT_ID": "saga",
        "AGENT_NAME": "Saga (Analyst)",
        "AGENT_PLATFORM": "claude-code",
        "AGENT_PROJECT": "my-project",
        "AGENT_FRAMEWORK": "WDS"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`) — same structure.

**Other IDEs** — any platform that supports MCP can use this server. For platforms without MCP support, use the [HTTP API directly](https://github.com/whiteport-design-studio/design-space-infrastructure).

## MCP Tools (14)

### Knowledge Capture
| Tool | Purpose |
|------|---------|
| `capture_knowledge` | Store design insights, patterns, methodology learnings |
| `capture_visual` | Capture screenshot + description with dual embeddings |
| `capture_feedback_pair` | Linked before/after design feedback with reasoning |
| `recent_knowledge` | Show recent entries |
| `space_stats` | Overview statistics |

### Search
| Tool | Purpose |
|------|---------|
| `search_space` | Semantic search across all knowledge |
| `search_visual_similarity` | Find visually similar patterns |
| `search_preference_patterns` | Red flag detection — check against rejections |

### Agent Messaging
| Tool | Purpose |
|------|---------|
| `send_agent_message` | Send message to another agent |
| `check_agent_messages` | Check inbox for unread messages |
| `respond_to_message` | Reply to a message thread |
| `register_presence` | Update agent status and identity |
| `who_online` | See which agents are active |
| `check_notifications` | Check real-time notification queue |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DESIGN_SPACE_URL` | Yes | Supabase project URL |
| `DESIGN_SPACE_ANON_KEY` | Yes | Supabase anonymous key |
| `AGENT_ID` | No | Agent identity (e.g., "saga", "freya") |
| `AGENT_NAME` | No | Display name (e.g., "Saga (Analyst)") |
| `AGENT_PLATFORM` | No | Platform (default: "claude-code") |
| `AGENT_PROJECT` | No | Project scope |
| `AGENT_FRAMEWORK` | No | Methodology (e.g., "WDS") |

## Architecture

```
Your IDE (Claude Code, Cursor, etc.)
  └── MCP Protocol
       └── design-space-mcp (this server)
            └── HTTP
                 └── Supabase Edge Functions (universal API)
                      └── PostgreSQL + pgvector
```

The MCP server is a thin wrapper. The real work happens in the Edge Functions — which any HTTP client can call directly. This means:

- **Claude Code / Cursor / Windsurf** → use this MCP server
- **ChatGPT** → use the OpenAPI spec with Custom GPT Actions
- **Any other tool** → POST to the Edge Functions directly

## Dashboard

Open `dashboard.html` in a browser to see agent conversations in real-time. It connects directly to Supabase from the browser — no server needed.

## Part of WDS

This server is part of the [Whiteport Design Studio](https://github.com/whiteport-design-studio/whiteport-design-studio) methodology. Install WDS for the full agent-driven design workflow with Saga (Strategy) and Freya (Design).

## License

MIT
