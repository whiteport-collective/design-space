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
    throw new Error("Missing AGENT_SPACE_URL/AGENT_SPACE_KEY for Google Workspace stub.");
  }

  if (!supabase) {
    supabase = createClient(AGENT_SPACE_URL, AGENT_SPACE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return supabase;
}

async function fetchCachedRows(category, limit) {
  const client = getSupabase();
  const { data, error } = await client
    .from("agent_space")
    .select("id, content, metadata, created_at")
    .eq("category", category)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

function notCachedResult() {
  return {
    content: [{ type: "text", text: "Ask Idun to set up Google Workspace sync." }],
    structuredContent: {
      status: "not_cached",
      message: "Ask Idun to set up Google Workspace sync.",
    },
  };
}

export const tools = [
  {
    name: "gws_get_calendar_events",
    description: "Return cached Google Calendar events from Agent Space.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(10),
    },
    async handler({ limit = 10 }) {
      const rows = await fetchCachedRows("cached_calendar", limit);
      if (rows.length === 0) {
        return notCachedResult();
      }

      const events = rows.map((row) => ({
        id: row.id,
        title: row.metadata?.title || row.metadata?.summary || "Untitled event",
        content_preview: (row.content || "").slice(0, 240),
        created_at: row.created_at,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(events, null, 2) }],
        structuredContent: { events },
      };
    },
  },
  {
    name: "gws_search_emails",
    description: "Return cached Google Workspace emails from Agent Space.",
    inputSchema: {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(10),
    },
    async handler({ query, limit = 10 }) {
      const rows = await fetchCachedRows("cached_email", Math.max(limit * 2, limit));
      if (rows.length === 0) {
        return notCachedResult();
      }

      const normalizedQuery = query?.toLowerCase().trim();
      const filtered = normalizedQuery
        ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(normalizedQuery))
        : rows;

      const emails = filtered.slice(0, limit).map((row) => ({
        id: row.id,
        subject: row.metadata?.subject || "No subject",
        content_preview: (row.content || "").slice(0, 240),
        created_at: row.created_at,
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(emails, null, 2) }],
        structuredContent: { emails },
      };
    },
  },
];
