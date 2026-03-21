// Transcript parser — chunks Fireflies transcripts into Design Space entries
// Groups consecutive same-speaker sentences into blocks, merges up to ~800 tokens

import type { FirefliesTranscript, FirefliesSentence } from "./fetch-transcript.ts";

export interface TranscriptChunk {
  content: string;
  topics: string[];
  speakers: string[];
  startTime: number;
  endTime: number;
  isSummary: boolean;
  chunkIndex: number;
}

interface SpeakerBlock {
  speaker: string;
  sentences: FirefliesSentence[];
  startTime: number;
  endTime: number;
}

const MAX_CHUNK_CHARS = 3200; // ~800 tokens

function normalizeTime(value: number | string | null | undefined): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(numeric) ? numeric : 0;
}

function groupBySpeaker(sentences: FirefliesSentence[]): SpeakerBlock[] {
  const blocks: SpeakerBlock[] = [];
  let current: SpeakerBlock | null = null;

  for (const s of sentences) {
    if (current && current.speaker === s.speaker_name) {
      current.sentences.push(s);
      current.endTime = normalizeTime(s.end_time);
    } else {
      if (current) blocks.push(current);
      current = {
        speaker: s.speaker_name,
        sentences: [s],
        startTime: normalizeTime(s.start_time),
        endTime: normalizeTime(s.end_time),
      };
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function blockToText(block: SpeakerBlock): string {
  const text = block.sentences.map(s => s.text).join(" ");
  return `**${block.speaker}:** ${text}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildPreamble(transcript: FirefliesTranscript): string {
  const date = new Date(transcript.date).toISOString().split("T")[0];
  const speakerNames = transcript.speakers.map(s => s.name).join(", ");
  const durationMin = Math.round(transcript.duration);
  return `Meeting: ${transcript.title} | ${date} | ${durationMin}min | Speakers: ${speakerNames}`;
}

export function parseTranscript(transcript: FirefliesTranscript): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  const preamble = buildPreamble(transcript);
  const speakerNames = [...new Set(transcript.speakers.map(s => s.name))];
  const keywords = transcript.summary?.keywords ?? [];
  const transcriptEndTime =
    transcript.sentences?.length
      ? normalizeTime(transcript.sentences[transcript.sentences.length - 1].end_time)
      : Math.round(transcript.duration * 60);
  let chunkIndex = 0;

  // Summary chunk first (highest value for search)
  if (transcript.summary) {
    const parts: string[] = [preamble, ""];

    if (transcript.summary.overview) {
      parts.push(`## Overview\n${transcript.summary.overview}`);
    }

    if (transcript.summary.action_items?.length) {
      parts.push(`\n## Action Items`);
      for (const item of transcript.summary.action_items) {
        parts.push(`- ${item}`);
      }
    }

    if (transcript.summary.shorthand_bullet?.length) {
      parts.push(`\n## Key Points`);
      for (const point of transcript.summary.shorthand_bullet) {
        parts.push(`- ${point}`);
      }
    }

    const summaryContent = parts.join("\n");
    if (summaryContent.length > preamble.length + 10) {
      chunks.push({
        content: summaryContent,
        topics: keywords,
        speakers: speakerNames,
        startTime: 0,
        endTime: transcriptEndTime,
        isSummary: true,
        chunkIndex: chunkIndex++,
      });
    }
  }

  // Conversation chunks — merge speaker blocks up to MAX_CHUNK_CHARS
  const blocks = groupBySpeaker(transcript.sentences ?? []);
  let currentChunkParts: string[] = [preamble, ""];
  let currentLength = preamble.length;
  let chunkStartTime = blocks[0]?.startTime ?? 0;
  let chunkEndTime = 0;
  const chunkSpeakers = new Set<string>();

  for (const block of blocks) {
    const text = blockToText(block);

    if (currentLength + text.length > MAX_CHUNK_CHARS && currentChunkParts.length > 2) {
      // Emit current chunk
      chunks.push({
        content: currentChunkParts.join("\n"),
        topics: keywords,
        speakers: [...chunkSpeakers],
        startTime: chunkStartTime,
        endTime: chunkEndTime,
        isSummary: false,
        chunkIndex: chunkIndex++,
      });

      // Start new chunk
      currentChunkParts = [
        preamble,
        `[${formatTime(block.startTime)}]`,
        "",
      ];
      currentLength = preamble.length + 20;
      chunkStartTime = block.startTime;
      chunkSpeakers.clear();
    }

    currentChunkParts.push(text);
    currentLength += text.length;
    chunkEndTime = block.endTime;
    chunkSpeakers.add(block.speaker);
  }

  // Emit final chunk
  if (currentChunkParts.length > 2) {
    chunks.push({
      content: currentChunkParts.join("\n"),
      topics: keywords,
      speakers: [...chunkSpeakers],
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      isSummary: false,
      chunkIndex: chunkIndex++,
    });
  }

  return chunks;
}
