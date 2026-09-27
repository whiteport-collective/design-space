-- 031: publish_jobs — mobile publishing pipeline audit table (WO-003)
--
-- One row per publishing session. Tracks draft → iteration → publish lifecycle.
-- mobile-Ivonne reads/writes this table via edge functions create-article,
-- update-article, and publish-article.

CREATE TABLE IF NOT EXISTS publish_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Article identity
  slug          text        NOT NULL,
  branch        text        NOT NULL,         -- e.g. draft/nar-min-claude
  title         text,
  author        text        NOT NULL DEFAULT 'Mårten Angner',

  -- Drive folder binding (set once on create, permanent)
  media_folder  text,                         -- e.g. Communication/2026-05-02 Title
                                              -- or   Events/2026-02-23 Event Name

  -- Lifecycle
  status        text        NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'iterating', 'published', 'failed')),
  published_to  text        CHECK (published_to IN ('staging', 'live', null)),

  -- Content
  material      text,                         -- raw input from Mårten
  preview_url   text,
  live_url      text,

  -- Iteration history: [{n, feedback, ts}]
  -- n            int    — iteration number (1-based)
  -- feedback     text   — Mårten's instruction
  -- ts           text   — ISO timestamp
  iterations    jsonb       NOT NULL DEFAULT '[]',

  -- Timestamps
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

-- Slug lookup: "is there already a job for this slug?"
CREATE INDEX IF NOT EXISTS publish_jobs_slug_idx       ON publish_jobs (slug);

-- Status filter: "list all drafts"
CREATE INDEX IF NOT EXISTS publish_jobs_status_idx     ON publish_jobs (status);

-- Recency: "show recent jobs"
CREATE INDEX IF NOT EXISTS publish_jobs_created_at_idx ON publish_jobs (created_at DESC);

-- RLS: edge functions use service-role key; anon has no access
ALTER TABLE publish_jobs ENABLE ROW LEVEL SECURITY;

-- No policies needed — service-role bypasses RLS.
-- If anon reads are ever needed, add a policy here.

COMMENT ON TABLE publish_jobs IS
  'One row per mobile publishing session. Tracks draft → iteration → live lifecycle for WO-003 pipeline.';

COMMENT ON COLUMN publish_jobs.media_folder IS
  'Permanent binding to the Google Drive folder for this article. Set once on create via list-media-folders. '
  'Format: ''Communication/2026-05-02 Title'' or ''Events/2026-02-23 Event Name''.';

COMMENT ON COLUMN publish_jobs.iterations IS
  'Array of feedback rounds. Each entry: {n: int, feedback: string, ts: ISO8601}.';
