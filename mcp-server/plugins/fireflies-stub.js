import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const AGENT_SPACE_URL = process.env.AGENT_SPACE_URL || process.env.DESIGN_SPACE_URL;
const AGENT_SPACE_KEY =
  process.env.AGENT_SPACE_KEY ||
  process.env.DESIGN_SPACE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase;

function getSupabase() {
  if (!AGENT_SPACE_URL || !AGENT_SPACE_KEY) {
    throw new Error("Missing AGENT_SPACE_URL/AGENT_SPACE_KEY for Fireflies stub.");
  }

  if (!supabase) {
    supabase = createClient(AGENT_SPACE_URL, AGENT_SPACE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return supabase;
}

export const tools = [
  {
    name: "fireflies_get_recent_transcripts",
    description: "Return cached Fireflies meeting transcripts from Agent Space.",
    inputSchema: {
      limit: z.number().int().min(1).max(10).default(10),
    },
    async handler({ limit = 10 }) {
      const client = getSupabase();
      const { data, error } = await client
        .from("agent_space")
        .select("id, content, metadata, created_at")
        .eq("category", "meeting_transcript")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        throw error;
      }

      const transcripts = (data || []).map((row) => ({
        id: row.id,
        title: row.metadata?.title || "Untitled transcript",
        content_preview: (row.content || "").slice(0, 240),
        created_at: row.created_at,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(transcripts, null, 2) }],
        structuredContent: { transcripts },
      };
    },
  },
];
