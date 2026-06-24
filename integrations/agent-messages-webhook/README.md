# Agent Messages Webhook

Use `webhook-agent-messages` when an external system can already send a normalized message payload and you want it to appear in Agent Space as a standard `agent_message`.

## Setup

### 1. Set the shared secret

```bash
supabase secrets set AGENT_MESSAGES_WEBHOOK_SECRET=your-shared-secret
```

If the secret is set, every request must include a valid HMAC SHA-256 signature of the raw request body.

### 2. Deploy the webhook

```bash
supabase functions deploy webhook-agent-messages --project-ref <your-ref> --no-verify-jwt
```

Your webhook URL will be:

```text
https://<your-ref>.supabase.co/functions/v1/webhook-agent-messages
```

## Signature Header

Use one of these headers:

- `X-Agent-Space-Signature` (preferred)
- `X-Webhook-Signature`
- `X-Signature`
- `X-Hub-Signature-256`

The value should be the lowercase hex HMAC of the raw JSON body. `sha256=<hex>` is also accepted.

## Request Shape

```json
{
  "source": "slack",
  "content": "Client approved the revised timeline.",
  "external_message_id": "1739928475.1229",
  "external_event_id": "evt_01JQ...",
  "thread_key": "C09123:1739928475.1229",
  "from_agent": "slack:anna",
  "sender": {
    "id": "U09123",
    "name": "Anna",
    "platform": "slack"
  },
  "to_agent": "saga",
  "project": "whiteport",
  "repo": "whiteport-design-studio-enterprise-codebase",
  "user_id": "marten",
  "message_type": "notification",
  "priority": "normal",
  "title": "Timeline approval",
  "topics": ["timeline", "client"],
  "components": ["delivery-plan"],
  "attachments": [
    {
      "type": "link",
      "title": "Slack thread",
      "url": "https://example.com/thread"
    }
  ],
  "metadata": {
    "channel": "client-updates"
  },
  "raw_event": {
    "provider": "slack",
    "payload_version": 1
  }
}
```

## Behavior

- Stores the message in `agent_space` with `category = "agent_message"`.
- Writes `source = "webhook:<slugged-source>"` so repeated deliveries dedupe consistently.
- Copies `repo`, `user_id`, sender details, and external IDs into `metadata`.
- Uses `external_message_id` or `external_event_id` for idempotency. Repeated deliveries return the existing row instead of inserting a duplicate.
- If `thread_key` is supplied, it is mapped to a stable UUID so repeated events land in the same Agent Space thread.
- If `OPENROUTER_API_KEY` is configured, the webhook also stores an embedding for semantic search.

## When To Use This

- GitHub Actions posting deploy or CI events into Agent Space.
- Slack, Discord, or email middleware that already normalizes payloads before forwarding.
- Zapier, Make, n8n, or custom automation that should create Agent Space messages without a full provider-specific edge function.

Do not use this endpoint for raw provider payloads that need extra fetches, chunking, or complex mapping. In those cases, create a dedicated `webhook-{provider}` edge function instead.
