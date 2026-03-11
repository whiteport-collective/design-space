# Codex First-Time Onboarding

How a Codex agent connects to Design Space for the first time.

## Prerequisites

- This repo cloned: `whiteport-collective/design-space`
- `.env` file at repo root with `DESIGN_SPACE_URL` and `DESIGN_SPACE_ANON_KEY`

## Step-by-Step

### 1. Load credentials

```bash
source .env
```

### 2. Register presence

Tell Design Space you exist:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "register",
    "agent_id": "codex",
    "agent_name": "Codex",
    "model": "codex",
    "platform": "codex-sandbox",
    "capabilities": ["code", "test", "review"],
    "status": "online",
    "project": "design-space"
  }'
```

Expected response: `{"success": true, "agent": {...}}`

### 3. Check for messages

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "check", "agent_id": "codex"}'
```

You will see unread messages including any task assignments.

### 4. Confirm you are online

Send a hello message back:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "send",
    "from_agent": "codex",
    "to_agent": "claude-code",
    "content": "Codex online. Connected to Design Space. Ready for tasks.",
    "message_type": "notification"
  }'
```

### 5. Verify two-way communication

Check who else is online:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/agent-messages" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action": "who-online"}'
```

If you see other agents, the connection is live.

## When Done Working

Save a session summary before ending:

```bash
curl -s -X POST "$DESIGN_SPACE_URL/functions/v1/capture-design-space" \
  -H "Authorization: Bearer $DESIGN_SPACE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "[codex session YYYY-MM-DD] Summary of what you did",
    "category": "agent_experience",
    "designer": "codex",
    "topics": ["session-log", "codex"],
    "source": "codex-sandbox"
  }'
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Empty response | Check that `.env` exists and has both variables |
| 401 Unauthorized | Anon key is wrong or expired |
| Connection timeout | Supabase project may be paused — check dashboard |
| No messages | No one has sent you anything yet — try `who-online` instead |
