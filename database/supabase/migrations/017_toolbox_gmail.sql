-- Migration 017: Register toolbox tools in plugin_catalog
-- Tools are server-side API proxies that agents call via HTTP edge functions.
-- No MCP installation needed — credentials and connections live in Agent Space.

insert into public.plugin_catalog (
  plugin_slug,
  display_name,
  version,
  category,
  dependencies,
  default_enabled,
  config_schema
) values
  ('tool_gmail', 'Gmail', '1', 'tool', '{}', false, '{
    "secrets": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
    "actions": ["list", "read", "send", "search"],
    "endpoint": "/functions/v1/tool-gmail"
  }'::jsonb)
on conflict (plugin_slug) do update
set
  display_name = excluded.display_name,
  version = excluded.version,
  category = excluded.category,
  config_schema = excluded.config_schema,
  updated_at = now();

-- Activate for Whiteport org
insert into public.org_plugin_installations (
  org_id,
  plugin_slug,
  status,
  activated_at
) values
  ('whiteport', 'tool_gmail', 'planned', now())
on conflict (org_id, plugin_slug) do update
set
  status = excluded.status,
  updated_at = now();
