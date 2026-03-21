#!/usr/bin/env -S deno run --allow-net --allow-env
// Manual sync — backfill Fireflies transcripts into Design Space
//
// Usage:
//   deno run --allow-net --allow-env sync.ts              # last 7 days
//   deno run --allow-net --allow-env sync.ts --days 30    # last 30 days
//   deno run --allow-net --allow-env sync.ts --id abc123  # specific transcript
//
// Env vars:
//   FIREFLIES_API_KEY       — Fireflies API key
//   DESIGN_SPACE_URL        — e.g. https://<ref>.supabase.co/functions/v1
//   DESIGN_SPACE_KEY        — Supabase anon key
//   FIREFLIES_PROJECT_MAP   — optional JSON project mapping rules

import { fetchTranscript, listRecentTranscripts } from "./fetch-transcript.ts";
import { parseTranscript } from "./parse-transcript.ts";
import { mapToProject, loadProjectMap } from "./project-mapper.ts";

const FIREFLIES_KEY = Deno.env.get("FIREFLIES_API_KEY");
const DS_URL = Deno.env.get("DESIGN_SPACE_URL");
const DS_KEY = Deno.env.get("DESIGN_SPACE_KEY");

if (!FIREFLIES_KEY) {
  console.error("FIREFLIES_API_KEY not set");
  Deno.exit(1);
}
if (!DS_URL || !DS_KEY) {
  console.error("DESIGN_SPACE_URL and DESIGN_SPACE_KEY must be set");
  Deno.exit(1);
}

interface ChunkMetadata {
  project: string | null;
  designer: string | null;
  topics: string[];
  source_file: string;
  meeting_id: string;
  title: string;
  date: string;
  duration: number;
  speakers: string[];
  participants: string[];
  chunk_index: number;
  total_chunks: number;
  is_summary: boolean;
  start_time: number;
  end_time: number;
}

async function captureChunk(content: string, meta: ChunkMetadata) {
  const response = await fetch(`${DS_URL}/capture-design-space`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DS_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      category: "meeting_transcript",
      project: meta.project,
      designer: meta.designer,
      topics: meta.topics,
      components: [],
      source: "fireflies",
      source_file: meta.source_file,
      metadata: {
        meeting_id: meta.meeting_id,
        title: meta.title,
        date: meta.date,
        duration: meta.duration,
        speakers: meta.speakers,
        participants: meta.participants,
        chunk_index: meta.chunk_index,
        total_chunks: meta.total_chunks,
        is_summary: meta.is_summary,
        start_time: meta.start_time,
        end_time: meta.end_time,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Capture failed: ${response.status} ${text}`);
  }

  return await response.json();
}

async function sendNotification(content: string, project: string | null) {
  await fetch(`${DS_URL}/agent-messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DS_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "send",
      from_agent: "fireflies-bot",
      to_agent: null,
      content,
      message_type: "notification",
      project,
      priority: "normal",
      topics: ["meeting", "transcript"],
    }),
  });
}

// Supabase REST base URL (strip /functions/v1 to get the project URL)
const DS_REST_URL = DS_URL!.replace(/\/functions\/v1\/?$/, "");

interface ExistingChunkRow {
  content: string;
  metadata?: {
    chunk_index?: unknown;
  };
}

async function getExistingChunks(sourceFile: string): Promise<ExistingChunkRow[]> {
  const url = `${DS_REST_URL}/rest/v1/design_space?source_file=eq.${encodeURIComponent(sourceFile)}&select=content,metadata`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${DS_KEY}`,
      "apikey": DS_KEY!,
    },
  });

  if (!response.ok) return [];

  return await response.json();
}

async function processTranscript(transcriptId: string) {
  const sourceFile = `fireflies:${transcriptId}`;

  const transcript = await fetchTranscript(FIREFLIES_KEY!, transcriptId);
  const chunks = parseTranscript(transcript);
  const projectMap = loadProjectMap();
  const project = mapToProject(transcript, projectMap);
  const speakerNames = transcript.speakers.map(s => s.name);
  const date = new Date(transcript.date).toISOString().split("T")[0];

  // Dedup/recovery: match exact stored chunks by chunk index or content.
  const existingChunks = await getExistingChunks(sourceFile);
  const storedIndices = new Set<number>();
  const storedContents = new Set<string>();
  for (const row of existingChunks) {
    const idx = row.metadata?.chunk_index;
    if (typeof idx === "number") storedIndices.add(idx);
    if (typeof row.content === "string") storedContents.add(row.content);
  }
  const isStored = (chunk: ReturnType<typeof parseTranscript>[number]) =>
    storedIndices.has(chunk.chunkIndex) || storedContents.has(chunk.content);

  if (chunks.every(isStored)) {
    console.log(`  Skipped (all ${chunks.length} chunks already stored): ${transcriptId}`);
    return 0;
  }
  if (existingChunks.length > 0) {
    console.log(`  Partial: ${existingChunks.length}/${chunks.length} chunks exist, storing remaining...`);
  }

  let stored = 0;
  for (const chunk of chunks) {
    if (isStored(chunk)) {
      continue;
    }

    try {
      await captureChunk(chunk.content, {
        project,
        designer: speakerNames[0] ?? null,
        topics: chunk.topics,
        source_file: sourceFile,
        meeting_id: transcriptId,
        title: transcript.title,
        date,
        duration: transcript.duration,
        speakers: speakerNames,
        participants: transcript.participants ?? [],
        chunk_index: chunk.chunkIndex,
        total_chunks: chunks.length,
        is_summary: chunk.isSummary,
        start_time: chunk.startTime,
        end_time: chunk.endTime,
      });
      stored++;
    } catch (err) {
      console.error(`  Failed chunk ${chunk.chunkIndex}: ${err.message}`);
    }
  }

  // Notify agents
  const durationMin = Math.round(transcript.duration);
  await sendNotification(
    `Synced meeting transcript: "${transcript.title}" (${durationMin}min, ${speakerNames.length} speakers). ${stored} chunks stored.`,
    project,
  );

  console.log(`  Stored ${stored}/${chunks.length} chunks for "${transcript.title}"`);
  return stored;
}

// --- CLI ---

const args = [...Deno.args];
let mode: "recent" | "id" = "recent";
let days = 7;
let specificId = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--days" && args[i + 1]) {
    days = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === "--id" && args[i + 1]) {
    mode = "id";
    specificId = args[i + 1];
    i++;
  }
}

if (mode === "id") {
  console.log(`Syncing transcript: ${specificId}`);
  const count = await processTranscript(specificId);
  console.log(`Done. ${count} chunks stored.`);
} else {
  console.log(`Syncing transcripts from last ${days} days...`);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const transcripts = await listRecentTranscripts(FIREFLIES_KEY!, 50);
  const recent = transcripts.filter(t => t.date >= cutoff);

  console.log(`Found ${recent.length} transcripts in range.`);

  let totalStored = 0;
  for (const t of recent) {
    console.log(`Processing: ${t.title} (${t.id})`);
    totalStored += await processTranscript(t.id);
  }

  console.log(`\nSync complete. ${totalStored} total chunks stored from ${recent.length} transcripts.`);
}
