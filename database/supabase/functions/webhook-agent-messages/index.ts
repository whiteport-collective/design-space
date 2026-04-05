// webhook-agent-messages: Receive normalized external webhook payloads and store them as Agent Space messages
// POST { source, content, external_message_id?, external_event_id?, thread_id?, thread_key?, from_agent?, sender?, to_agent?, project?, repo?, user_id?, message_type?, priority?, title?, topics?, components?, attachments?, metadata?, raw_event? }
// Headers: X-Agent-Space-Signature (preferred) or X-Webhook-Signature when AGENT_MESSAGES_WEBHOOK_SECRET is set
// Env: AGENT_MESSAGES_WEBHOOK_SECRET (optional), OPENROUTER_API_KEY (optional)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-agent-space-signature, x-webhook-signature, x-signature, x-hub-signature-256",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function slugToken(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function readSignature(headers: Headers): string | null {
  const candidates = [
    headers.get("x-agent-space-signature"),
    headers.get("x-webhook-signature"),
    headers.get("x-signature"),
    headers.get("x-hub-signature-256"),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = candidate.startsWith("sha256=")
      ? candidate.slice(7)
      : candidate;
    return value.trim().toLowerCase();
  }

  return null;
}

async function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return signature === expected;
}

async function getEmbedding(text: string): Promise<number[] | null> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/text-embedding-3-small",
        input: text,
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.data[0].embedding;
  } catch {
    return null;
  }
}

async function stableThreadId(
  source: string,
  threadKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${source}:${threadKey}`),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function findExistingMessage(
  supabase: ReturnType<typeof createClient>,
  sourceKey: string,
  externalMessageId: string | null,
  externalEventId: string | null,
) {
  const identifiers = [
    { key: "external_message_id", value: externalMessageId },
    { key: "external_event_id", value: externalEventId },
  ];

  for (const identifier of identifiers) {
    if (!identifier.value) continue;

    const { data, error } = await supabase
      .from("agent_space")
      .select("*")
      .eq("category", "agent_message")
      .eq("source", `webhook:${sourceKey}`)
      .eq(`metadata->>${identifier.key}`, identifier.value)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;
  }

  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      endpoint: "webhook-agent-messages",
      description:
        "POST a normalized external message payload to store it in Agent Space.",
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const webhookSecret = Deno.env.get("AGENT_MESSAGES_WEBHOOK_SECRET");
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const bodyText = await req.text();

    if (webhookSecret) {
      const signature = readSignature(req.headers);
      const valid = await verifySignature(bodyText, signature, webhookSecret);
      if (!valid) {
        return jsonResponse({ error: "Invalid webhook signature" }, 401);
      }
    }

    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const source = asString(body.source);
    const content = asString(body.content);
    const sender = asObject(body.sender);
    const fromAgent = asString(body.from_agent);
    const senderName = asString(sender.name);
    const senderId = asString(sender.id);
    const senderPlatform = asString(sender.platform);
    const toAgent = asString(body.to_agent);
    const project = asString(body.project);
    const repo = asString(body.repo);
    const userId = asString(body.user_id);
    const messageType = asString(body.message_type) || "notification";
    const priority = asString(body.priority) || "normal";
    const title = asString(body.title);
    const externalMessageId = asString(body.external_message_id);
    const externalEventId = asString(body.external_event_id);
    const threadIdInput = asString(body.thread_id);
    const threadKey = asString(body.thread_key);
    const extraMetadata = asObject(body.metadata);
    const rawEvent = asObject(body.raw_event);
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const topics = asStringArray(body.topics);
    const components = asStringArray(body.components);

    if (!source || !content) {
      return jsonResponse({ error: "source and content are required" }, 400);
    }

    const sourceKey = slugToken(source);
    if (!sourceKey) {
      return jsonResponse(
        { error: "source must include at least one alphanumeric character" },
        400,
      );
    }

    const existing = await findExistingMessage(
      supabase,
      sourceKey,
      externalMessageId,
      externalEventId,
    );
    if (existing) {
      return jsonResponse({
        message: existing,
        duplicate: true,
        thread_id: existing.thread_id,
      });
    }

    const derivedSender =
      fromAgent ||
      (senderId ? `${sourceKey}:${slugToken(senderId)}` : null) ||
      (senderName ? `${sourceKey}:${slugToken(senderName)}` : null) ||
      `webhook-${sourceKey}`;
    const effectiveProject = project || repo;
    const effectiveRepo = repo || project;
    const threadId =
      threadIdInput && UUID_PATTERN.test(threadIdInput)
        ? threadIdInput
        : threadKey
          ? await stableThreadId(sourceKey, threadKey)
          : crypto.randomUUID();
    const embeddingText = title ? `${title}\n${content}` : content;
    const embedding = await getEmbedding(embeddingText);

    const metadata = {
      ...extraMetadata,
      from_agent: derivedSender,
      from_platform: senderPlatform || "webhook",
      to_agent: toAgent || null,
      message_type: messageType,
      priority,
      attachments,
      read_by: [],
      repo: effectiveRepo || null,
      user_id: userId || null,
      external_source: sourceKey,
      external_source_label: source,
      external_message_id: externalMessageId || null,
      external_event_id: externalEventId || null,
      external_thread_key: threadKey || null,
      external_sender_id: senderId || null,
      external_sender_name: senderName || null,
      raw_event: Object.keys(rawEvent).length ? rawEvent : null,
      title: title || null,
    };

    const { data: message, error } = await supabase
      .from("agent_space")
      .insert({
        content,
        category: "agent_message",
        project: effectiveProject || null,
        source: `webhook:${sourceKey}`,
        topics,
        components,
        embedding,
        thread_id: threadId,
        metadata,
      })
      .select()
      .single();

    if (error) throw error;

    return jsonResponse(
      { message, duplicate: false, thread_id: threadId },
      201,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
});
