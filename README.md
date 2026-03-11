# Design Space

Monorepo for the Design Space — cross-LLM, cross-IDE agent communication and design knowledge capture. Built on Supabase (PostgreSQL + pgvector + Edge Functions).

## Structure

```
design-space/
├── supabase/           Migrations + Edge Functions (Deno/TypeScript)
│   ├── migrations/     4 SQL files run in order
│   └── functions/      7 edge functions
├── mcp-server/         MCP server for IDE integration (14 tools)
├── hooks/              Claude Code lifecycle hooks (Python + Node)
├── agents/             Agent workspace templates (Codex, Gemini)
├── jobs/               Task specs for external agents
└── setup.sh            One-command Supabase deployment
```

## What This Does

- **Semantic knowledge capture** — Store design insights with 1536d text embeddings
- **Visual pattern memory** — Dual embeddings: semantic + 1024d visual (Voyage AI)
- **Feedback learning** — Linked before/after pairs teach the system your design taste
- **Red flag detection** — Check new designs against known rejections before presenting
- **Agent messaging** — Cross-LLM, cross-IDE agent communication where every message is searchable knowledge
- **Presence & discovery** — Agents register online, discover peers, filter by capability

## Quick Start

### 1. Create a Supabase Project

Go to [supabase.com](https://supabase.com) and create a new project. Note your project reference ID.

### 2. Deploy

```bash
chmod +x setup.sh
./setup.sh YOUR-PROJECT-REF
```

### 3. Set Secrets

In the Supabase dashboard, Edge Functions, Secrets:

| Secret | Required | Purpose |
|--------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | Semantic embeddings (text-embedding-3-small) |
| `VOYAGE_API_KEY` | For visuals | Visual embeddings (voyage-multimodal-3) |

### 4. Connect

Get your project URL and anon key from Supabase dashboard, Settings, API.

**MCP Server (recommended for IDE agents):**
```bash
cd mcp-server
cp .env.example .env
# Edit .env with your Supabase URL, key, and agent identity
npm install
# Add to your IDE's MCP config (see mcp-server/README.md)
```

**Python (zero dependencies):**
```python
from ds_client import DesignSpace
ds = DesignSpace()
ds.capture("Dark backgrounds work better for dashboards", category="successful_pattern")
results = ds.search("dashboard patterns")
ds.send_message("freya", "Review the landing page")
```

Copy `hooks/ds_client.py` into your project. No pip install needed.

**Claude Code Hooks:**
```bash
# Copy hooks to your Claude Code hooks directory
# See hooks/ for SessionStart, PostToolUse, and Stop hooks
```

## Edge Functions (7)

### Knowledge Capture
| Function | Purpose |
|----------|---------|
| `capture-design-space` | Store text knowledge with semantic embedding |
| `capture-visual` | Screenshot + description with dual embeddings |
| `capture-feedback-pair` | Linked before/after improvement pair |

### Search
| Function | Purpose |
|----------|---------|
| `search-design-space` | Semantic similarity search with filters |
| `search-visual-similarity` | Find visually similar patterns |
| `search-preference-patterns` | Red flag detection against rejections |

### Agent Communication
| Function | Purpose |
|----------|---------|
| `agent-messages` | Send, check, respond, register, who-online, mark-read, thread |

## MCP Server Tools (14)

See [mcp-server/README.md](mcp-server/README.md) for full tool documentation.

## Database Schema

### `design_space` table
Primary knowledge store. Every entry — design insight, visual capture, or agent message — lives here with optional embeddings.

### `agent_presence` table
Tracks which agents are online, their capabilities, and what they're working on.

## SQL Migrations

Run in order:
1. `001_design_space_table.sql` — Main table, pgvector indexes
2. `002_agent_presence_table.sql` — Agent tracking
3. `003_rls_policies.sql` — Row Level Security + Realtime
4. `004_search_functions.sql` — Vector similarity search RPCs

## License

MIT
