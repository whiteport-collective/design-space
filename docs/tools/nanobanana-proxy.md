# NanoBanana Proxy — Agent Space

Gemini image generation available to any agent via a single HTTP call to the Design Space edge function.

**Endpoint:** `https://uztngidbpduyodrabokm.supabase.co/functions/v1/nanobanana-proxy`

---

## Request

```json
POST /functions/v1/nanobanana-proxy
Content-Type: application/json
apikey: <supabase-anon-key>

{
  "prompt": "...",
  "model": "nb2",
  "aspect_ratio": "16:9",
  "reference_images": []
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `prompt` | string | required | The image generation prompt |
| `model` | string | `"nb2"` | See model aliases below |
| `aspect_ratio` | string | `"16:9"` | Hint included in prompt |
| `reference_images` | array | `[]` | `[{ data: "<base64>", mime_type: "image/jpeg" }]` |

### Model aliases

| Alias | Model |
|---|---|
| `nb2` / `flash` | `gemini-3.1-flash-image-preview` (default — same as NanoBanana MCP) |
| `pro` | `gemini-3-pro-image-preview` |
| `fast` | `gemini-2.5-flash-image` |

---

## Response

```json
{
  "image_base64": "<base64-encoded JPEG/PNG>",
  "mime_type": "image/jpeg",
  "model": "gemini-3.1-flash-image-preview",
  "prompt": "...",
  "aspect_ratio": "16:9",
  "metadata": {
    "finish_reason": "STOP",
    "usage": { ... }
  }
}
```

On error: `{ "error": "message" }` with HTTP 400/500.

---

## Shell example (save image to disk)

```bash
ANON_KEY="<supabase-anon-key>"

curl -s -X POST \
  "https://uztngidbpduyodrabokm.supabase.co/functions/v1/nanobanana-proxy" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  -d '{"prompt": "Documentary photo of a mechanic changing oil, warm workshop light"}' \
  | python -c "
import sys, json, base64
d = json.load(sys.stdin)
if 'error' in d: print('ERROR:', d['error']); exit(1)
ext = 'jpg' if 'jpeg' in d['mime_type'] else 'png'
open(f'output.{ext}', 'wb').write(base64.b64decode(d['image_base64']))
print('saved output.' + ext)
"
```

## Node.js example

```js
import { writeFileSync } from 'fs';

const res = await fetch(
  'https://uztngidbpduyodrabokm.supabase.co/functions/v1/nanobanana-proxy',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
    body: JSON.stringify({ prompt: 'your prompt here', aspect_ratio: '16:9' }),
  }
);
const data = await res.json();
if (data.error) throw new Error(data.error);
writeFileSync('output.jpg', Buffer.from(data.image_base64, 'base64'));
```

---

## Key & billing

- **Gemini key:** "Gemini API Key — Whiteport (NanoBanana Agent Space)" in Bitwarden
- **Google project:** Whiteport (`gen-lang-client-0262215538`)
- **Billing tier:** Tier 2 · Postpay (My Billing Account)
- **Supabase secret:** `GEMINI_API_KEY` on project `uztngidbpduyodrabokm`
