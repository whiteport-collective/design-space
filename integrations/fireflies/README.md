# Fireflies.ai Integration

Captures meeting transcripts from Fireflies.ai into Design Space. Agents can then search meetings: *"what did the client say about pricing?"*

## Setup

### 1. Get your Fireflies API key

1. Log in to https://app.fireflies.ai
2. Go to **Integrations** > **Fireflies API**
3. Copy your API key

### 2. Set Supabase secrets

```bash
supabase secrets set FIREFLIES_API_KEY=your-api-key
supabase secrets set FIREFLIES_WEBHOOK_SECRET=your-webhook-secret
```

The webhook secret is a 16-32 character string you choose. You'll enter the same secret in Fireflies.

### 3. Deploy the webhook

```bash
supabase functions deploy webhook-fireflies --project-ref <your-ref>
```

Your webhook URL will be:
```
https://<your-ref>.supabase.co/functions/v1/webhook-fireflies
```

### 4. Configure Fireflies webhook

1. In Fireflies, go to **Developer Settings** > **Webhooks**
2. Add your webhook URL
3. Enter the same secret you set in step 2
4. Select event: **Transcription completed**

### 5. Configure project mapping (optional)

Copy `config.example.json` and set it as an env var:

```bash
supabase secrets set FIREFLIES_PROJECT_MAP='{"rules":[...]}'
```

Or leave it unset — transcripts will be stored with `project: null`.

## Manual Sync

Backfill existing transcripts:

```bash
# Last 7 days (default)
deno run --allow-net --allow-env sync.ts

# Last 30 days
deno run --allow-net --allow-env sync.ts --days 30

# Specific transcript
deno run --allow-net --allow-env sync.ts --id <transcript-id>
```

Required env vars for sync:
```
FIREFLIES_API_KEY=...
DESIGN_SPACE_URL=https://<ref>.supabase.co/functions/v1
DESIGN_SPACE_KEY=<anon-key>
```

## How It Works

1. Fireflies sends a webhook when transcription completes
2. The edge function fetches the full transcript via GraphQL
3. Transcript is chunked by speaker blocks (~800 tokens each)
4. Summary and action items become a separate high-priority chunk
5. Each chunk is stored with embedding in `design_space` table
6. A broadcast notification tells agents about the new meeting

## Data Model

Each chunk is stored as:
- **category:** `meeting_transcript`
- **source:** `fireflies`
- **source_file:** `fireflies:{transcriptId}` (used for deduplication)
- **topics:** extracted from Fireflies keywords
- **metadata:** meeting title, date, duration, speakers, chunk index

## Rate Limits

- Free/Pro: 50 API requests/day
- Business: 60 requests/minute
- Webhook processing is event-driven (1 call per transcript)
