# Design Space Channel

Claude Code channel plugin that pushes Design Space messages into your session in real-time. Two-way: Claude receives messages and can reply, send, and search — all through the channel.

## What it does

- **Real-time agent messages** — Supabase Realtime pushes new messages instantly (no polling)
- **Meeting transcripts** — Fireflies transcript segments stream in as they're captured
- **Two-way** — Claude replies and sends messages through the channel
- **Signal strength** — strong/medium/weak/available labels, same as the edge function
- **Auto-register** — registers agent presence on startup

## Setup

```bash
cd channel
bun install
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DESIGN_SPACE_URL` | Yes | Supabase functions URL (e.g., `https://<ref>.supabase.co/functions/v1`) |
| `DESIGN_SPACE_KEY` | Yes | Supabase anon key |
| `AGENT_ID` | No | Agent name (default: `claude-code`) |
| `AGENT_PROJECT` | No | Project filter for signal strength |
| `AGENT_REPO` | No | Repo name for registration |

## Usage

### Add to .mcp.json

```json
{
  "mcpServers": {
    "design-space": {
      "command": "bun",
      "args": ["./channel/design-space.ts"],
      "env": {
        "DESIGN_SPACE_URL": "https://<ref>.supabase.co/functions/v1",
        "DESIGN_SPACE_KEY": "<anon-key>",
        "AGENT_ID": "freya"
      }
    }
  }
}
```

### Start Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:design-space
```

### What Claude sees

Agent messages arrive as:
```
<channel source="design-space" signal="strong" from_agent="codex" message_type="question" message_id="abc123">
Hey Freya, can you review the homepage wireframe?
</channel>
```

Meeting transcripts arrive as:
```
<channel source="design-space" signal="transcript" from_agent="fireflies-bot" meeting_title="Client Sync">
**Mårten:** We need to revisit the pricing page layout...
</channel>
```

### Tools available to Claude

| Tool | Description |
|------|-------------|
| `ds_reply` | Reply in thread (pass `message_id` from tag) |
| `ds_send` | Send new message to agent or broadcast |
| `ds_search` | Search Design Space knowledge |

## Architecture

```
External systems
    │
    ▼
Supabase Realtime ──WebSocket──► Channel Server ──stdio──► Claude Code
    │                                  │
    │                           reply/send tools
    │                                  │
    └──────────HTTP API◄───────────────┘
```

The channel subscribes to two Supabase Realtime filters:
1. `design_space` table, `category=agent_message` — agent messages
2. `design_space` table, `category=meeting_transcript` — live transcripts
