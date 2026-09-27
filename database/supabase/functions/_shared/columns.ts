// Column lists for agent_space / design_space reads.
//
// Why this file exists: agent_space carries `embedding vector(1536)` and
// `visual_embedding vector(1024)` (migration 001). A single row serialises to
// ~19 kB of vector against ~3 kB of content, so `select("*")` spends 86 % of
// its bytes on numbers the caller never looks at. On 2026-09-18 that cost the
// project 15,25 GB of egress against a 5 GB quota — see
// EGRESS-INCIDENT-2026-09-18.md.
//
// Rule: no caller outside the search functions may read a vector column.
// Import a list from here instead of writing `*`, so the next `select("*")`
// has nowhere to hide.
//
// The search functions (search-design-space, search-knowledge,
// search-visual-similarity, search-preference-patterns) legitimately need
// `embedding` / `visual_embedding` and deliberately do NOT use these lists.

/** Every non-vector column on agent_space / design_space. */
// Written as one literal string, not a joined array: supabase-js infers the row
// type from the column string at compile time, and a .join() result is just
// `string`, which collapses every query result to GenericStringError.
export const ENTRY_COLUMNS =
  "id, content, category, project, designer, client, topics, components, source, source_file, pattern_type, quality_score, pair_id, metadata, thread_id, created_at, updated_at";

/** What an agent message needs to be routed, scored and displayed. */
export const MESSAGE_COLUMNS =
  "id, content, category, project, topics, components, source, source_file, metadata, thread_id, created_at, updated_at";

/**
 * Inbox listing: everything needed to decide whether to open a message.
 * `content` is fetched but truncated before it leaves the function — see
 * previewMessage(). Full text comes from the `thread` or `get` action.
 */
export const MESSAGE_LIST_COLUMNS = MESSAGE_COLUMNS;

/**
 * Default characters of `content` returned in a preview listing.
 * Chosen by measurement against the real inbox, not taste. A listing exists to
 * let an agent decide what to open; a headline fits inside 140.
 */
export const PREVIEW_CHARS = 140;

/**
 * Default cap on direct messages in a PREVIEW listing.
 *
 * Measured on ivonne's inbox (182 unread): a lean preview costs ~533 bytes per
 * row, of which only 140 are content — the rest is id, thread_id, timestamp and
 * routing metadata, which cannot be shrunk without breaking routing. So the row
 * count, not the text length, is what keeps a listing small:
 *   200 rows ~107 kB · 120 rows ~64 kB · 70 rows ~39 kB
 * Preview callers are pollers that want headlines, so they get a lower default
 * and `has_more_direct` when it truncates. Full-content callers keep 200.
 */
export const PREVIEW_DIRECT_LIMIT = 100;

/**
 * Metadata fields a listing actually needs — to route a message, score its
 * signal and render one line about it. Everything else (working_on,
 * from_platform, attachments, read_by) is dead weight in a list view and is
 * dropped. Full metadata comes back with the message itself.
 */
const PREVIEW_METADATA_FIELDS = [
  "from_agent",
  "to_agent",
  "message_type",
  "priority",
  "title",
  "status",
  "repo",
  "user_id",
  // Routing fields. ds.js and conductor.js filter on these to decide whether a
  // message belongs to this machine and where to launch it — dropping them
  // would silently mis-route, not merely truncate.
  "target_machine",
  "working_directory",
  "project",
];

/**
 * Truncate `content` for a list view, keeping enough for an agent to judge
 * relevance. Adds `content_length` + `truncated` so the caller knows there is
 * more to fetch and by how much.
 */
export function previewMessage(message: any, chars: number = PREVIEW_CHARS) {
  const content: string = message?.content ?? "";
  const meta = message?.metadata ?? {};
  const leanMeta: Record<string, unknown> = {};
  for (const field of PREVIEW_METADATA_FIELDS) {
    const value = meta[field];
    if (value !== undefined && value !== null && value !== "") {
      leanMeta[field] = value;
    }
  }

  const preview: Record<string, unknown> = {
    id: message.id,
    thread_id: message.thread_id,
    created_at: message.created_at,
    project: message.project,
    signal: message.signal,
    metadata: leanMeta,
    content: content.length > chars ? content.slice(0, chars) : content,
    content_length: content.length,
    truncated: content.length > chars,
  };
  return preview;
}

/**
 * Exclude messages an agent has already read, in the query rather than in JS
 * afterwards. Filtering after the download means read messages still cost full
 * egress, which is how a mostly-read inbox stayed expensive.
 *
 * `metadata->read_by` is missing on some older rows (7 at time of writing), and
 * `NOT (NULL @> '["x"]')` is NULL, not TRUE — a bare `not.cs` would silently
 * drop exactly those rows. The `is.null` branch keeps them visible.
 */
export function excludeRead(query: any, agentIds: string[]) {
  for (const id of agentIds) {
    if (!id) continue;
    // JSON-encode so an agent id containing a quote cannot break out of the filter.
    const needle = JSON.stringify([id]);
    query = query.or(`metadata->read_by.is.null,metadata->read_by.not.cs.${needle}`);
  }
  return query;
}
