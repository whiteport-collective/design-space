-- Migration 023: Social media tools — tool_unipile + tool_publer
-- Unipile: LinkedIn personal (Mårten). Cache: messages, activity. Signals: priority rules.
-- Publer: Whiteport business pages (Facebook, Instagram, LinkedIn company).
-- Auth: API keys from Supabase secrets — no user_vault, no OAuth.

-- ============================================================
-- PLUGIN CATALOG: tool_unipile
-- ============================================================

INSERT INTO public.plugin_catalog (
  plugin_slug, display_name, version, category, default_enabled, config_schema
) VALUES (
  'tool_unipile', 'Unipile LinkedIn', '1', 'tool', false,
  '{
    "auth": "api_key",
    "secret": "UNIPILE_API_KEY",
    "account_secret": "UNIPILE_ACCOUNT_ID",
    "base_url_secret": "UNIPILE_BASE_URL",
    "actions": ["post", "message", "reply-comment", "connect", "notifications", "search", "sync", "cache-search", "cache-stats"],
    "endpoint": "/functions/v1/tool-unipile",
    "note": "Personal LinkedIn only — Whiteport company page uses tool_publer"
  }'::jsonb
) ON CONFLICT (plugin_slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  version = EXCLUDED.version,
  config_schema = EXCLUDED.config_schema,
  updated_at = now();

INSERT INTO public.org_plugin_installations (org_id, plugin_slug, status, activated_at)
VALUES ('whiteport', 'tool_unipile', 'active', now())
ON CONFLICT (org_id, plugin_slug) DO UPDATE SET status = 'active', updated_at = now();

-- ============================================================
-- PLUGIN CATALOG: tool_publer
-- ============================================================

INSERT INTO public.plugin_catalog (
  plugin_slug, display_name, version, category, default_enabled, config_schema
) VALUES (
  'tool_publer', 'Publer Social Media', '1', 'tool', false,
  '{
    "auth": "api_key",
    "secret": "PUBLER_API_KEY",
    "accounts": ["facebook:whiteport-page", "instagram:whiteport", "linkedin:whiteport-company"],
    "actions": ["create_post", "list_scheduled", "delete_post", "get_analytics"],
    "endpoint": "/functions/v1/tool-publer",
    "note": "Business pages only — personal profiles use tool_unipile"
  }'::jsonb
) ON CONFLICT (plugin_slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  version = EXCLUDED.version,
  config_schema = EXCLUDED.config_schema,
  updated_at = now();

INSERT INTO public.org_plugin_installations (org_id, plugin_slug, status, activated_at)
VALUES ('whiteport', 'tool_publer', 'active', now())
ON CONFLICT (org_id, plugin_slug) DO UPDATE SET status = 'active', updated_at = now();

-- ============================================================
-- CACHE: LinkedIn messages
-- ============================================================

CREATE TABLE IF NOT EXISTS public.linkedin_message_cache (
  id                text PRIMARY KEY,
  chat_id           text NOT NULL,
  sender_name       text,
  sender_profile_id text,
  content           text,
  sent_at           timestamptz,
  is_read           boolean DEFAULT false,
  cached_at         timestamptz DEFAULT now(),
  search_vector     tsvector
);

CREATE INDEX IF NOT EXISTS linkedin_message_cache_sent_at_idx
  ON public.linkedin_message_cache (sent_at DESC);

CREATE INDEX IF NOT EXISTS linkedin_message_cache_search_idx
  ON public.linkedin_message_cache USING GIN (search_vector);

-- Auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION public.linkedin_message_cache_update_search()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.sender_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS linkedin_message_cache_search_trigger ON public.linkedin_message_cache;
CREATE TRIGGER linkedin_message_cache_search_trigger
  BEFORE INSERT OR UPDATE ON public.linkedin_message_cache
  FOR EACH ROW EXECUTE FUNCTION public.linkedin_message_cache_update_search();

-- ============================================================
-- CACHE: LinkedIn activity (likes + comments on own posts)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.linkedin_activity_cache (
  id               text PRIMARY KEY,
  post_id          text NOT NULL,
  post_snippet     text,
  type             text CHECK (type IN ('like', 'comment')),
  actor_name       text,
  actor_profile_id text,
  content          text,
  activity_at      timestamptz,
  cached_at        timestamptz DEFAULT now(),
  search_vector    tsvector
);

CREATE INDEX IF NOT EXISTS linkedin_activity_cache_activity_at_idx
  ON public.linkedin_activity_cache (activity_at DESC);

CREATE INDEX IF NOT EXISTS linkedin_activity_cache_search_idx
  ON public.linkedin_activity_cache USING GIN (search_vector);

CREATE OR REPLACE FUNCTION public.linkedin_activity_cache_update_search()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.actor_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS linkedin_activity_cache_search_trigger ON public.linkedin_activity_cache;
CREATE TRIGGER linkedin_activity_cache_search_trigger
  BEFORE INSERT OR UPDATE ON public.linkedin_activity_cache
  FOR EACH ROW EXECUTE FUNCTION public.linkedin_activity_cache_update_search();

-- ============================================================
-- SIGNALS: LinkedIn priority rules
-- ============================================================

CREATE TABLE IF NOT EXISTS public.linkedin_signal_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text CHECK (type IN ('person', 'topic')),
  pattern        text NOT NULL,
  notify_agents  text[] DEFAULT '{"ivonne"}',
  priority       text DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  context        text,
  active         boolean DEFAULT true,
  created_at     timestamptz DEFAULT now()
);
