-- Migration 020: Register tool_calendar in plugin catalog
-- Uses same Google OAuth app as tool_gmail (shared credentials in org_plugin_installations).
-- Calendar scope already granted during Mårten's OAuth consent (2026-04-07).

INSERT INTO public.plugin_catalog (
  plugin_slug, display_name, version, category, dependencies, default_enabled, config_schema
) VALUES (
  'tool_calendar', 'Google Calendar', '1', 'tool', '{"tool_oauth"}', false,
  '{
    "org_config": "Uses same Google OAuth app as tool_gmail (shared client_id/secret)",
    "user_credentials": "user_vault (service: google, scopes include calendar)",
    "actions": ["list", "get", "create", "update", "free-busy"],
    "endpoint": "/functions/v1/tool-calendar"
  }'::jsonb
) ON CONFLICT (plugin_slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  version = EXCLUDED.version,
  config_schema = EXCLUDED.config_schema,
  updated_at = now();

-- Activate for Whiteport
INSERT INTO public.org_plugin_installations (org_id, plugin_slug, status, activated_at)
VALUES ('whiteport', 'tool_calendar', 'active', now())
ON CONFLICT (org_id, plugin_slug) DO UPDATE SET status = 'active', updated_at = now();
