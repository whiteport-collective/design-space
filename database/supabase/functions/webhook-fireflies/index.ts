// webhook-fireflies: Receive Fireflies.ai webhook, fetch transcript, chunk, store in Design Space
// POST { meetingId, eventType, clientReferenceId }
// Env: FIREFLIES_API_KEY, FIREFLIES_WEBHOOK_SECRET, OPENROUTER_API_KEY (optional)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Embedding (same pattern as capture-design-space) ---

async function getEmbedding(text: string): Promise<number[] | null> {
  const openRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!openRouterKey) return null;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
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

// --- Webhook signature verification ---

async function verifySignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return signature === expected;
}

// --- Fireflies GraphQL client (inlined) ---

interface Sentence {
  speaker_name: string;
  text: string;
  start_time: number;
  end_time: number;
}

interface Speaker {
  id: string;
  name: string;
}

interface Transcript {
  id: string;
  title: string;
  date: number;
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: Speaker[];
  sentences: Sentence[];
  summary: {
    action_items: string[];
    keywords: string[];
    overview: string;
    shorthand_bullet: string[];
  };
}

async function fetchTranscript(apiKey: string, transcriptId: string): Promise<Transcript> {
  const response = await fetch("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `query Transcript($id: String!) {
        transcript(id: $id) {
          id title date duration organizer_email participants
          speakers { id name }
          sentences { speaker_name text start_time end_time }
          summary { action_items keywords overview shorthand_bullet }
        }
      }`,
      variables: { id: transcriptId },
    }),
  });

  if (!response.ok) {
    throw new Error(`Fireflies API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`Fireflies GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data.transcript;
}

// --- Transcript chunking (inlined) ---

const MAX_CHUNK_CHARS = 3200;

interface Chunk {
  content: string;
  topics: string[];
  speakers: string[];
  startTime: number;
  endTime: number;
  isSummary: boolean;
  chunkIndex: number;
}

function buildPreamble(t: Transcript): string {
  const date = new Date(t.date).toISOString().split("T")[0];
  const names = t.speakers.map(s => s.name).join(", ");
  const mins = Math.round(t.duration);
  return `Meeting: ${t.title} | ${date} | ${mins}min | Speakers: ${names}`;
}

function chunkTranscript(transcript: Transcript): Chunk[] {
  const chunks: Chunk[] = [];
  const preamble = buildPreamble(transcript);
  const speakerNames = [...new Set(transcript.speakers.map(s => s.name))];
  const keywords = transcript.summary?.keywords ?? [];
  let idx = 0;

  // Summary chunk
  if (transcript.summary?.overview) {
    const parts = [preamble, "", `## Overview\n${transcript.summary.overview}`];

    if (transcript.summary.action_items?.length) {
      parts.push("\n## Action Items");
      for (const item of transcript.summary.action_items) parts.push(`- ${item}`);
    }

    if (transcript.summary.shorthand_bullet?.length) {
      parts.push("\n## Key Points");
      for (const point of transcript.summary.shorthand_bullet) parts.push(`- ${point}`);
    }

    chunks.push({
      content: parts.join("\n"),
      topics: keywords,
      speakers: speakerNames,
      startTime: 0,
      endTime: transcript.duration,
      isSummary: true,
      chunkIndex: idx++,
    });
  }

  // Group consecutive same-speaker sentences into blocks, merge blocks into chunks
  const sentences = transcript.sentences ?? [];
  if (!sentences.length) return chunks;

  let currentParts = [preamble, ""];
  let currentLen = preamble.length;
  let chunkStart = sentences[0].start_time;
  let chunkEnd = 0;
  const chunkSpeakers = new Set<string>();
  let prevSpeaker = "";
  let blockText = "";

  function emitBlock() {
    if (!blockText) return;
    const line = `**${prevSpeaker}:** ${blockText}`;
    if (currentLen + line.length > MAX_CHUNK_CHARS && currentParts.length > 2) {
      chunks.push({
        content: currentParts.join("\n"),
        topics: keywords,
        speakers: [...chunkSpeakers],
        startTime: chunkStart,
        endTime: chunkEnd,
        isSummary: false,
        chunkIndex: idx++,
      });
      currentParts = [preamble, ""];
      currentLen = preamble.length;
      chunkStart = chunkEnd;
      chunkSpeakers.clear();
    }
    currentParts.push(line);
    currentLen += line.length;
    chunkSpeakers.add(prevSpeaker);
  }

  for (const s of sentences) {
    if (s.speaker_name !== prevSpeaker && blockText) {
      emitBlock();
      blockText = "";
    }
    prevSpeaker = s.speaker_name;
    blockText += (blockText ? " " : "") + s.text;
    chunkEnd = s.end_time;
  }
  emitBlock();

  // Final chunk
  if (currentParts.length > 2) {
    chunks.push({
      content: currentParts.join("\n"),
      topics: keywords,
      speakers: [...chunkSpeakers],
      startTime: chunkStart,
      endTime: chunkEnd,
      isSummary: false,
      chunkIndex: idx++,
    });
  }

  return chunks;
}

// --- Project mapping (inlined) ---

interface MappingRule {
  titlePattern?: string;
  participantEmail?: string;
  project: string;
}

function mapToProject(transcript: Transcript): string | null {
  const raw = Deno.env.get("FIREFLIES_PROJECT_MAP");
  if (!raw) return null;

  let config: { rules: MappingRule[]; default: string | null };
  try {
    config = JSON.parse(raw);
  } catch {
    return null;
  }

  for (const rule of config.rules) {
    if (rule.titlePattern && new RegExp(rule.titlePattern, "i").test(transcript.title)) {
      return rule.project;
    }
    if (rule.participantEmail) {
      const email = rule.participantEmail.toLowerCase();
      if (transcript.participants?.some(p => p.toLowerCase() === email)) return rule.project;
      if (transcript.organizer_email?.toLowerCase() === email) return rule.project;
    }
  }

  return config.default;
}

// --- Helper ---

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Main handler ---

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const firefliesKey = Deno.env.get("FIREFLIES_API_KEY");
  if (!firefliesKey) {
    return jsonResponse({ error: "FIREFLIES_API_KEY not configured" }, 500);
  }

  const webhookSecret = Deno.env.get("FIREFLIES_WEBHOOK_SECRET");

  try {
    const bodyText = await req.text();

    // Verify webhook signature if secret is configured
    if (webhookSecret) {
      const signature = req.headers.get("x-hub-signature");
      const valid = await verifySignature(bodyText, signature, webhookSecret);
      if (!valid) {
        return jsonResponse({ error: "Invalid webhook signature" }, 401);
      }
    }

    const payload = JSON.parse(bodyText);
    const { meetingId, eventType } = payload;

    if (eventType !== "Transcription completed") {
      return jsonResponse({ skipped: true, reason: `Unhandled event: ${eventType}` });
    }

    if (!meetingId) {
      return jsonResponse({ error: "meetingId is required" }, 400);
    }

    // Connect to Supabase
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check for existing chunks (handles both full duplicates and partial writes)
    const sourceFile = `fireflies:${meetingId}`;
    const { data: existing } = await supabase
      .from("design_space")
      .select("id, metadata")
      .eq("source_file", sourceFile);

    // Fetch full transcript from Fireflies
    const transcript = await fetchTranscript(firefliesKey, meetingId);
    if (!transcript) {
      return jsonResponse({ error: "Failed to fetch transcript" }, 502);
    }

    // Chunk transcript
    const chunks = chunkTranscript(transcript);
    const project = mapToProject(transcript);
    const date = new Date(transcript.date).toISOString().split("T")[0];
    const speakerNames = transcript.speakers.map(s => s.name);

    // Full duplicate — all chunks already stored
    const existingCount = existing?.length ?? 0;
    if (existingCount >= chunks.length) {
      return jsonResponse({ skipped: true, reason: "Transcript already processed", meetingId });
    }

    // Find which chunk indices are already stored (for partial write recovery)
    const storedIndices = new Set<number>();
    for (const row of existing ?? []) {
      const idx = row.metadata?.chunk_index;
      if (typeof idx === "number") storedIndices.add(idx);
    }

    // Store missing chunks
    const stored: string[] = [];
    const failed: number[] = [];
    for (const chunk of chunks) {
      if (storedIndices.has(chunk.chunkIndex)) continue;

      const embedding = await getEmbedding(chunk.content);

      const { data: entry, error } = await supabase
        .from("design_space")
        .insert({
          content: chunk.content,
          category: "meeting_transcript",
          project,
          designer: speakerNames[0] ?? null,
          topics: chunk.topics,
          components: [],
          source: "fireflies",
          source_file: sourceFile,
          embedding,
          metadata: {
            meeting_id: meetingId,
            title: transcript.title,
            date,
            duration: transcript.duration,
            speakers: speakerNames,
            participants: transcript.participants,
            chunk_index: chunk.chunkIndex,
            total_chunks: chunks.length,
            is_summary: chunk.isSummary,
            start_time: chunk.startTime,
            end_time: chunk.endTime,
          },
        })
        .select("id")
        .single();

      if (error) {
        console.error(`Failed to store chunk ${chunk.chunkIndex}:`, error);
        failed.push(chunk.chunkIndex);
        continue;
      }
      stored.push(entry.id);
    }

    // If any chunks failed, return partial success (webhook can retry)
    if (failed.length > 0) {
      return jsonResponse({
        partial: true,
        meetingId,
        chunksStored: stored.length,
        chunksFailed: failed,
        totalChunks: chunks.length,
      }, 206);
    }

    // Broadcast notification to agents
    const durationMin = Math.round(transcript.duration);
    const notificationContent = `New meeting transcript: "${transcript.title}" (${durationMin}min, ${speakerNames.length} speakers). ${stored.length} chunks stored. Search with: category "meeting_transcript", source "fireflies".`;

    const thread_id = crypto.randomUUID();
    const notifEmbedding = await getEmbedding(notificationContent);

    await supabase.from("design_space").insert({
      content: notificationContent,
      category: "agent_message",
      project,
      topics: ["meeting", "transcript", ...(transcript.summary?.keywords?.slice(0, 5) ?? [])],
      components: [],
      source: "fireflies",
      source_file: null,
      embedding: notifEmbedding,
      thread_id,
      metadata: {
        from_agent: "fireflies-bot",
        from_platform: "webhook",
        to_agent: null, // broadcast
        message_type: "notification",
        priority: "normal",
        read_by: [],
        attachments: [],
        meeting_id: meetingId,
        chunks_stored: stored.length,
      },
    });

    return jsonResponse({
      success: true,
      meetingId,
      title: transcript.title,
      chunksStored: stored.length,
      project,
    });

  } catch (err) {
    console.error("webhook-fireflies error:", err);
    return jsonResponse({ error: err.message }, 500);
  }
});
