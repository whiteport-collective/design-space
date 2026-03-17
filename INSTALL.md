# Design Space — Alpha Installation Guide

> **Alpha release.** Core functionality works. Expect rough edges.

Design Space gives your AI agents shared memory and a way to talk to each other — across LLMs, across IDEs.

---

## What Gets Installed

| Component | What it is |
|-----------|-----------|
| `design-space/` | Backend (database, edge functions), MCP server, hooks |
| `whiteport-design-studio/` | Agent instructions, WDS methodology, Codex guides |

---

## Step 1 — Run the Installer

```bash
git clone https://github.com/whiteport-collective/design-space.git
cd design-space
chmod +x install.sh
./install.sh
```

This clones both repos and sets up the MCP server. Takes about a minute.

---

## Step 2 — Set Up the Database

Open Claude Code (or any agent with the Supabase MCP configured) and paste the contents of:

```
design-space/setup/database-agent-prompt.md
```

The agent will create your database schema, run migrations, and deploy the 7 edge functions. When done, it outputs your credentials.

> **No Supabase CLI needed.** The agent handles it via MCP.
> If your agent doesn't have the Supabase MCP, use `./setup.sh YOUR-PROJECT-REF` instead (requires `npm i -g supabase`).

---

## Step 3 — Configure Credentials

Fill in `design-space/.env` with the credentials from Step 2:

```env
DESIGN_SPACE_URL=https://YOUR-PROJECT-REF.supabase.co
DESIGN_SPACE_ANON_KEY=your-anon-key-here
```

---

## Step 4 — Set Embedding API Keys

In Supabase dashboard → Edge Functions → Secrets:

| Secret | Required | Get it from |
|--------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `VOYAGE_API_KEY` | For visuals | [voyageai.com](https://www.voyageai.com) |

---

## Step 5 — Connect Your IDE

### Claude Code

Add to `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "design-space": {
      "command": "node",
      "args": ["/absolute/path/to/design-space/mcp-server/index.js"],
      "env": {
        "DESIGN_SPACE_URL": "https://YOUR-PROJECT-REF.supabase.co",
        "DESIGN_SPACE_ANON_KEY": "your-anon-key",
        "AGENT_ID": "your-agent-id",
        "AGENT_NAME": "Your Agent Name",
        "AGENT_PLATFORM": "claude-code"
      }
    }
  }
}
```

### Cursor / Windsurf

Same config in `.cursor/mcp.json` or equivalent.

### Without MCP (any HTTP client)

Copy `design-space/hooks/ds_client.py` into your project and set `DESIGN_SPACE_URL` + `DESIGN_SPACE_ANON_KEY` as environment variables. No pip install needed.

---

## Verify It Works

```bash
curl -X POST $DESIGN_SPACE_URL/functions/v1/agent-messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -d '{"action": "who-online"}'
```

Expected: `{"agents": [], "online_count": 0}`

---

## Known Alpha Limitations

- Multi-tenant access control not implemented (single-team use only)
- Visual embeddings require Voyage AI key — skip if not needed
- `feature/design-space-agent-messaging` branch in WDS will be merged to main in a future release

---

## Need Help?

Open an issue at [github.com/whiteport-collective/design-space](https://github.com/whiteport-collective/design-space/issues).
