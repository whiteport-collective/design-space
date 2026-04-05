# Integrations

External data sources that feed into Design Space. Each integration captures knowledge or messages from a third-party service so agents can search it or act on it.

## Structure

```text
integrations/
|- agent-messages-webhook/  # Generic external message intake
|- fireflies/               # Meeting transcripts (Fireflies.ai)
`- (future)                 # Slack, Discord, email, etc.
```

Each integration follows the same pattern:

| File                  | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `README.md`           | Setup guide (API keys, webhook URL, config)      |
| `config.example.json` | Project-mapping rules template                   |
| `fetch-*.ts`          | Provider API client                              |
| `parse-*.ts`          | Transform provider data into Agent Space entries |
| `project-mapper.ts`   | Map provider events to Agent Space projects      |
| `sync.ts`             | Manual backfill CLI script                       |

Plus a corresponding Supabase edge function at `database/supabase/functions/webhook-{provider}/` for real-time ingestion via webhooks.

## Intake Patterns

- Use `webhook-agent-messages` when the external system can already send a normalized Agent Space message payload.
- Use a provider-specific `webhook-{provider}` edge function when the provider sends a raw payload that must be fetched, transformed, chunked, or re-mapped before storage.
- Deploy webhook functions with `--no-verify-jwt` and protect them with provider-specific secrets or `AGENT_MESSAGES_WEBHOOK_SECRET`.

## Adding a New Integration

1. Create `integrations/{provider}/` with the files above.
2. Create `database/supabase/functions/webhook-{provider}/index.ts`.
3. Deploy: `supabase functions deploy webhook-{provider} --no-verify-jwt`.
4. Set secrets: `supabase secrets set {PROVIDER}_API_KEY=...`.
5. Configure the webhook URL in the provider's dashboard.
6. Run `sync.ts` to backfill existing data.

All integrations store entries in the existing `agent_space` table with a provider-specific `category` (for example `meeting_transcript` or `agent_message`) and `source` field (for example `fireflies` or `webhook:slack`).
