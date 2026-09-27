-- Migration 025: Tool usage log
-- Fire-and-forget logging from all edge function tools.
-- Zero latency impact — logged after response is sent via Promise without await.
-- Useful for: cost tracking ($/month per tool), usage patterns, error rates, slow actions.

CREATE TABLE IF NOT EXISTS public.tool_usage_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_slug   text        NOT NULL,                        -- e.g. "tool-unipile", "tool-publer"
  action      text        NOT NULL,                        -- e.g. "post", "list_scheduled"
  ok          boolean     NOT NULL DEFAULT true,           -- success or error
  duration_ms integer,                                     -- end-to-end latency in ms
  error_msg   text,                                        -- error message if ok = false
  org_id      text        DEFAULT 'whiteport',             -- for future multi-tenant
  metadata    jsonb,                                       -- tool-specific context (see tool.md Analytics sections)
  called_at   timestamptz NOT NULL DEFAULT now()
);

-- Index for time-series queries and per-tool analysis
CREATE INDEX IF NOT EXISTS tool_usage_log_called_at_idx ON public.tool_usage_log (called_at DESC);
CREATE INDEX IF NOT EXISTS tool_usage_log_tool_slug_idx ON public.tool_usage_log (tool_slug, called_at DESC);
CREATE INDEX IF NOT EXISTS tool_usage_log_ok_idx        ON public.tool_usage_log (ok, called_at DESC);

-- Auto-prune: keep 90 days of logs
CREATE OR REPLACE FUNCTION public.prune_tool_usage_log()
RETURNS void AS $$
BEGIN
  DELETE FROM public.tool_usage_log WHERE called_at < now() - interval '90 days';
END;
$$ LANGUAGE plpgsql;

-- Convenience view: daily summary per tool + action
CREATE OR REPLACE VIEW public.tool_usage_daily AS
SELECT
  date_trunc('day', called_at)  AS day,
  tool_slug,
  action,
  count(*)                      AS calls,
  count(*) FILTER (WHERE ok)    AS successes,
  count(*) FILTER (WHERE NOT ok) AS errors,
  round(avg(duration_ms))       AS avg_ms,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)) AS p95_ms
FROM public.tool_usage_log
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;
