import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import postgres from "https://deno.land/x/postgresjs@v3.4.5/mod.js";

// Vault secret names
const ANTHROPIC_SECRET_NAME = "ANTHROPIC_API_KEY_SHARIF";
const GOOGLE_SECRET_NAME = "GOOGLE_SERVICE_ACCOUNT_SHARIF";

type Provider = "anthropic" | "google";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, anthropic-version, anthropic-beta",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getDatabase() {
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required.");
  return postgres(databaseUrl);
}

// Auth is handled by Supabase JWT verification at the gateway level.
// Custom token check is an optional additional layer for non-JWT callers.
function isAuthorized(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return false;
  // Accept any non-empty bearer token — Supabase gateway already verified the JWT.
  // For extra security, optionally check against a custom ANTHROPIC_GATEWAY_TOKEN.
  const expectedToken = Deno.env.get("ANTHROPIC_GATEWAY_TOKEN")?.trim();
  if (expectedToken) return token === expectedToken;
  return true;
}

// ------- Vault helpers -------

let cachedAnthropicKey: string | null = null;
let cachedAnthropicKeyAt = 0;
let cachedServiceAccount: Record<string, string> | null = null;
let cachedServiceAccountAt = 0;

async function getSecretFromVault(name: string): Promise<string> {
  const sql = getDatabase();
  try {
    const rows = await sql`
      select decrypted_secret
      from vault.decrypted_secrets
      where name = ${name}
      limit 1
    `;
    const secret =
      typeof rows[0]?.decrypted_secret === "string"
        ? rows[0].decrypted_secret.trim()
        : null;
    if (!secret) throw new Error(`${name} is not set in Supabase Vault.`);
    return secret;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function getAnthropicApiKey(): Promise<string> {
  if (cachedAnthropicKey && Date.now() - cachedAnthropicKeyAt < 60_000) {
    return cachedAnthropicKey;
  }
  // Prefer env var (set via supabase secrets), fall back to vault
  const envKey = Deno.env.get("ANTHROPIC_API_KEY_SHARIF")?.trim();
  cachedAnthropicKey = envKey ?? await getSecretFromVault(ANTHROPIC_SECRET_NAME);
  cachedAnthropicKeyAt = Date.now();
  return cachedAnthropicKey;
}

async function getGoogleServiceAccount(): Promise<Record<string, string>> {
  if (cachedServiceAccount && Date.now() - cachedServiceAccountAt < 60_000) {
    return cachedServiceAccount;
  }
  // Prefer env var (set via supabase secrets), fall back to vault
  const envSA = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_SHARIF")?.trim();
  const raw = envSA ?? await getSecretFromVault(GOOGLE_SECRET_NAME);
  cachedServiceAccount = JSON.parse(raw);
  cachedServiceAccountAt = Date.now();
  return cachedServiceAccount!;
}

// ------- Google auth -------

function base64UrlEncode(data: string | Uint8Array): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function getGoogleAccessToken(): Promise<string> {
  const sa = await getGoogleServiceAccount();
  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      sub: sa.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    }),
  );

  const signingInput = `${header}.${payload}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Google auth failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

// ------- Format translation -------

type AnthropicMessage = {
  role: string;
  content: string | Array<{ type: string; text: string }>;
};

function anthropicToGemini(body: Record<string, unknown>) {
  const messages = (body.messages as AnthropicMessage[]) ?? [];

  const contents = messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [
      {
        text:
          typeof msg.content === "string"
            ? msg.content
            : (msg.content as Array<{ type: string; text: string }>).find(
                  (p) => p.type === "text",
                )?.text ?? "",
      },
    ],
  }));

  const requestedTokens = (body.max_tokens as number) ?? 1024;

  // Disable thinking for both streaming and non-streaming.
  // gemini-2.5-flash with auto thinking budget consumes ALL maxOutputTokens for
  // internal reasoning, leaving 0 visible tokens. thinkingBudget: 0 forces all
  // tokens to go to visible output.
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: requestedTokens,
    temperature: 0.7,
    thinkingConfig: { thinkingBudget: 0 },
  };

  const result: Record<string, unknown> = { contents, generationConfig };

  if (body.system) {
    result.systemInstruction = {
      parts: [{ text: body.system as string }],
    };
  }

  return result;
}

// ------- Gemini SSE → Anthropic SSE translation -------

function sseLine(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapGeminiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "stop_sequence";
    case "STOP":
    case "FINISH_REASON_UNSPECIFIED":
    case "OTHER":
    case null:
    case undefined:
    default:
      return "end_turn";
  }
}

function translateGeminiStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (name: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseLine(name, data)));
      };

      // Initial Anthropic events expected by AI SDK
      enqueue("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      enqueue("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      enqueue("ping", { type: "ping" });

      const reader = upstream.getReader();
      let buffer = "";
      let finishReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload) as Record<string, unknown>;
          const candidates =
            (chunk.candidates as Array<Record<string, unknown>>) ?? [];
          const candidate = candidates[0];
          if (candidate?.finishReason) {
            finishReason = candidate.finishReason as string;
          }
          const parts =
            ((candidate?.content as Record<string, unknown> | undefined)
              ?.parts as Array<{ text?: string; thought?: boolean }>) ?? [];
          for (const part of parts) {
            if (part?.thought) continue;
            const text = part?.text;
            if (typeof text === "string" && text.length > 0) {
              enqueue("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
              });
            }
          }
          const usage = chunk.usageMetadata as Record<string, number> | undefined;
          if (usage) {
            if (typeof usage.promptTokenCount === "number") inputTokens = usage.promptTokenCount;
            if (typeof usage.candidatesTokenCount === "number") outputTokens = usage.candidatesTokenCount;
          }
        } catch (_) {
          // ignore malformed chunk
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete lines — Gemini SSE uses \n (not \n\n) between events
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep incomplete trailing line in buffer
          for (const line of lines) processLine(line);
        }
        // Process any remaining content in buffer
        if (buffer) processLine(buffer);
      } catch (err) {
        enqueue("error", {
          type: "error",
          error: {
            type: "api_error",
            message: err instanceof Error ? err.message : "stream_error",
          },
        });
      }

      enqueue("content_block_stop", { type: "content_block_stop", index: 0 });
      enqueue("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapGeminiFinishReason(finishReason),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      });
      // best-effort: patch message_start usage input_tokens via a ping-like echo
      // input_tokens is tracked in `inputTokens` if telemetry is added later.
      void inputTokens;
      enqueue("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}

function geminiToAnthropic(
  geminiResponse: Record<string, unknown>,
  originalModel: string,
) {
  const candidates =
    (geminiResponse.candidates as Array<Record<string, unknown>>) ?? [];
  const candidate = candidates[0];

  const text =
    (
      (
        (candidate?.content as Record<string, unknown>)?.parts as Array<{
          text?: string;
        }>
      ) ?? []
    )
      .map((p) => p.text ?? "")
      .join("") ?? "";

  const usage = geminiResponse.usageMetadata as
    | Record<string, number>
    | undefined;

  return {
    id: "msg_google",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: originalModel,
    stop_reason: "end_turn",
    usage: {
      input_tokens: usage?.promptTokenCount ?? 0,
      output_tokens: usage?.candidatesTokenCount ?? 0,
    },
  };
}

// ------- Main handler -------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const provider = (
    (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase()
  ) as Provider;

  // Health check — public, no auth required
  if (req.method === "GET" && url.pathname.endsWith("/health")) {
    try {
      if (provider === "google") {
        const sa = await getGoogleServiceAccount();
        return json({
          ok: true,
          provider: "google",
          project: sa.project_id,
          client_email: sa.client_email,
          model:
            Deno.env.get("GOOGLE_MODEL") ??
            "gemini-2.0-flash-001 (default)",
          location: Deno.env.get("GOOGLE_LOCATION") ?? "us-central1 (default)",
        });
      } else {
        const hasKey = Boolean(await getAnthropicApiKey());
        return json({
          ok: hasKey,
          provider: "anthropic",
          has_anthropic_key: hasKey,
          anthropic_secret_name: ANTHROPIC_SECRET_NAME,
          has_gateway_token: Boolean(
            Deno.env.get("ANTHROPIC_GATEWAY_TOKEN")?.trim(),
          ),
        });
      }
    } catch (e) {
      return json({ ok: false, provider, error: (e as Error).message }, 503);
    }
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/messages")) {
    return json({ error: "not_found" }, 404);
  }

  if (!isAuthorized(req)) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const bodyText = await req.text();
    const body = JSON.parse(bodyText) as Record<string, unknown>;

    if (provider === "anthropic") {
      const apiKey = await getAnthropicApiKey();
      const headers = new Headers();
      headers.set("x-api-key", apiKey);
      headers.set(
        "anthropic-version",
        req.headers.get("anthropic-version") ?? "2023-06-01",
      );
      headers.set("content-type", "application/json");
      const beta = req.headers.get("anthropic-beta");
      if (beta) headers.set("anthropic-beta", beta);

      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers,
        body: bodyText,
      });

      const resHeaders = new Headers(corsHeaders);
      resHeaders.set(
        "Content-Type",
        upstream.headers.get("content-type") ?? "application/json",
      );
      const requestId = upstream.headers.get("anthropic-request-id");
      if (requestId) resHeaders.set("anthropic-request-id", requestId);

      return new Response(upstream.body, {
        status: upstream.status,
        headers: resHeaders,
      });
    }

    if (provider === "google") {
      const accessToken = await getGoogleAccessToken();
      const sa = await getGoogleServiceAccount();

      const project = Deno.env.get("GOOGLE_PROJECT") ?? sa.project_id;
      const location = Deno.env.get("GOOGLE_LOCATION") ?? "us-central1";
      const rawModel = Deno.env.get("GOOGLE_MODEL")?.trim() ?? "";
      const claudeModelOverride = Deno.env.get("GOOGLE_CLAUDE_MODEL")?.trim();
      // Default to Gemini — Anthropic on Vertex requires quota approval that blocks demos.
      const googleProvider = (Deno.env.get("GOOGLE_PROVIDER") ?? "gemini").toLowerCase();

      // ---- Vertex AI — Anthropic passthrough ----
      if (googleProvider === "anthropic") {
        // Claude models are only available in us-central1 / us-east5, not europe-west1.
        // Use a separate GOOGLE_CLAUDE_LOCATION that defaults to us-central1.
        const claudeLocation = Deno.env.get("GOOGLE_CLAUDE_LOCATION")?.trim() || "us-central1";
        // Ignore GOOGLE_MODEL if it's a legacy Gemini name; prefer explicit Claude override or default.
        // Also pass through model from request body if caller specifies a claude- ID (for version probing).
        const requestModel = typeof body.model === "string" && body.model.startsWith("claude-") ? body.model : null;
        const model =
          claudeModelOverride ||
          (rawModel.startsWith("claude-") ? rawModel : null) ||
          requestModel ||
          "claude-sonnet-4-5@20251001";
        const isStream = body.stream === true;
        const method = isStream ? "streamRawPredict" : "rawPredict";
        const vertexUrl = `https://${claudeLocation}-aiplatform.googleapis.com/v1/projects/${project}/locations/${claudeLocation}/publishers/anthropic/models/${model}:${method}`;

        // Vertex expects anthropic_version instead of the `model` field in the body.
        const vertexBody: Record<string, unknown> = { ...body };
        delete vertexBody.model;
        if (!vertexBody.anthropic_version) {
          vertexBody.anthropic_version = "vertex-2023-10-16";
        }

        const upstream = await fetch(vertexUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(vertexBody),
        });

        if (!upstream.ok) {
          const err = await upstream.text();
          return json(
            { error: `Vertex Anthropic error (${upstream.status}): ${err}` },
            upstream.status,
          );
        }

        // Pipe upstream body directly — preserves SSE stream for streaming requests
        // and JSON body for non-streaming requests. Anthropic wire format is identical.
        const resHeaders = new Headers(corsHeaders);
        resHeaders.set(
          "Content-Type",
          upstream.headers.get("content-type") ?? "application/json",
        );
        const requestId = upstream.headers.get("x-request-id");
        if (requestId) resHeaders.set("anthropic-request-id", requestId);

        return new Response(upstream.body, {
          status: upstream.status,
          headers: resHeaders,
        });
      }

      // ---- Vertex AI — Gemini translation ----
      const isStream = body.stream === true;
      const geminiBody = anthropicToGemini(body);
      const geminiModelOverride = Deno.env.get("GOOGLE_GEMINI_MODEL")?.trim();
      // Use gemini-2.5-flash for everything — it's available in europe-west1.
      // Streaming uses enlarged token budget so thinking + visible output both fit.
      const fallbackModel = "gemini-2.5-flash";
      const geminiModel = geminiModelOverride ||
        (rawModel && !rawModel.startsWith("claude-") && rawModel !== "gemini-2.0-flash-001"
          ? rawModel
          : fallbackModel);
      const method = isStream ? "streamGenerateContent" : "generateContent";
      const queryString = isStream ? "?alt=sse" : "";
      const vertexUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${geminiModel}:${method}${queryString}`;

      const upstream = await fetch(vertexUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(geminiBody),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        return json({ error: `Google Vertex error (${upstream.status}): ${err}` }, upstream.status);
      }

      // Streaming: translate Gemini SSE → Anthropic SSE for AI SDK compatibility
      if (isStream && upstream.body) {
        // Debug mode: pipe raw Gemini SSE without translation
        if (req.headers.get("x-debug") === "raw") {
          const resHeaders = new Headers(corsHeaders);
          resHeaders.set("Content-Type", "text/plain");
          resHeaders.set("Cache-Control", "no-cache");
          return new Response(upstream.body, { status: 200, headers: resHeaders });
        }
        const anthropicStream = translateGeminiStreamToAnthropic(
          upstream.body,
          (body.model as string) ?? geminiModel,
        );
        const resHeaders = new Headers(corsHeaders);
        resHeaders.set("Content-Type", "text/event-stream");
        resHeaders.set("Cache-Control", "no-cache");
        resHeaders.set("Connection", "keep-alive");
        return new Response(anthropicStream, {
          status: 200,
          headers: resHeaders,
        });
      }

      // Non-streaming: translate Gemini JSON → Anthropic JSON
      const geminiResponse = await upstream.json() as Record<string, unknown>;
      const anthropicResponse = geminiToAnthropic(
        geminiResponse,
        (body.model as string) ?? geminiModel,
      );

      return json(anthropicResponse);
    }

    return json({ error: `Unknown provider: ${provider}` }, 400);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown LLM gateway error";
    return json({ error: message }, 500);
  }
});
