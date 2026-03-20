# Integrations

External data sources that feed into Design Space. Each integration captures knowledge from a third-party service so agents can search and act on it.

## Structure

```
integrations/
├── fireflies/     # Meeting transcripts (Fireflies.ai)
└── (future)       # Slack, Discord, email, etc.
```

Each integration follows the same pattern:

| File | Purpose |
|------|---------|
| `README.md` | Setup guide (API keys, webhook URL, config) |
| `config.example.json` | Project-mapping rules template |
| `fetch-*.ts` | Provider API client |
| `parse-*.ts` | Transform provider data into Design Space entries |
| `project-mapper.ts` | Map provider events to Design Space projects |
| `sync.ts` | Manual backfill CLI script |

Plus a corresponding Supabase edge function at `database/supabase/functions/webhook-{provider}/` for real-time ingestion via webhooks.

## Adding a New Integration

1. Create `integrations/{provider}/` with the files above
2. Create `database/supabase/functions/webhook-{provider}/index.ts`
3. Deploy: `supabase functions deploy webhook-{provider}`
4. Set secrets: `supabase secrets set {PROVIDER}_API_KEY=...`
5. Configure webhook URL in the provider's dashboard
6. Run `sync.ts` to backfill existing data

All integrations store entries in the existing `design_space` table with a provider-specific `category` (e.g., `meeting_transcript`, `slack_message`) and `source` field (e.g., `fireflies`, `slack`).
