-- Migration 018: User vault for per-user credentials + OAuth toolbox support
-- Separates org-level app config from per-user tokens.
-- Supports 1 user (Whiteport today) or 100 users (enterprise tomorrow).

-- 1. User vault — per-user credential storage
create table if not exists public.user_vault (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  service text not null,           -- 'google', 'github', 'slack', 'microsoft'
  credential_type text not null    -- 'oauth2', 'api_key', 'service_account'
    check (credential_type in ('oauth2', 'api_key', 'service_account')),
  credentials jsonb not null default '{}'::jsonb,
    -- oauth2:  { refresh_token, access_token, token_expires_at }
    -- api_key: { key }
    -- service_account: { key_json }
  scopes text[] not null default '{}',  -- granted OAuth scopes
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'pending')),
  last_refreshed_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id, service)
);

-- Indexes
create index if not exists idx_user_vault_org on public.user_vault (org_id);
create index if not exists idx_user_vault_user on public.user_vault (user_id);
create index if not exists idx_user_vault_service on public.user_vault (org_id, service);
create index if not exists idx_user_vault_lookup on public.user_vault (org_id, user_id, service);

-- Updated-at trigger
drop trigger if exists user_vault_updated_at on public.user_vault;
create trigger user_vault_updated_at
  before update on public.user_vault
  for each row execute function public.update_updated_at();

-- RLS — same pattern as other enterprise tables
alter table public.user_vault enable row level security;

drop policy if exists "user_vault_select" on public.user_vault;
drop policy if exists "user_vault_insert" on public.user_vault;
drop policy if exists "user_vault_update" on public.user_vault;
drop policy if exists "user_vault_delete" on public.user_vault;
create policy "user_vault_select" on public.user_vault for select using (true);
create policy "user_vault_insert" on public.user_vault for insert with check (true);
create policy "user_vault_update" on public.user_vault for update using (true);
create policy "user_vault_delete" on public.user_vault for delete using (true);

-- 2. OAuth state table — tracks in-flight authorization flows
create table if not exists public.oauth_state (
  state text primary key,           -- random state parameter
  org_id text not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  service text not null,
  scopes text[] not null default '{}',
  redirect_after text,              -- where to send user after success
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists idx_oauth_state_expires on public.oauth_state (expires_at);

alter table public.oauth_state enable row level security;
create policy "oauth_state_all" on public.oauth_state for all using (true);

-- 3. Update tool_gmail plugin registration — credentials now come from user_vault, not env vars
update public.plugin_catalog
set config_schema = '{
  "org_config": {
    "google_client_id": "OAuth app client ID (set in org_plugin_installations.config)",
    "google_client_secret": "OAuth app client secret (set in org_plugin_installations.config)"
  },
  "user_credentials": "user_vault (service: google, scopes include gmail)",
  "actions": ["list", "read", "send", "search"],
  "endpoint": "/functions/v1/tool-gmail"
}'::jsonb,
  version = '2',
  updated_at = now()
where plugin_slug = 'tool_gmail';

-- 4. Register tool_oauth in plugin catalog
insert into public.plugin_catalog (
  plugin_slug,
  display_name,
  version,
  category,
  dependencies,
  default_enabled,
  config_schema
) values
  ('tool_oauth', 'OAuth Connector', '1', 'tool', '{}', false, '{
    "actions": ["authorize", "callback", "status", "revoke"],
    "endpoint": "/functions/v1/tool-oauth",
    "supported_services": ["google"]
  }'::jsonb)
on conflict (plugin_slug) do update
set
  display_name = excluded.display_name,
  version = excluded.version,
  config_schema = excluded.config_schema,
  updated_at = now();

-- Activate both for Whiteport
insert into public.org_plugin_installations (
  org_id,
  plugin_slug,
  status,
  activated_at
) values
  ('whiteport', 'tool_oauth', 'active', now())
on conflict (org_id, plugin_slug) do update
set status = 'active', updated_at = now();

-- Update tool_gmail to active
update public.org_plugin_installations
set status = 'active', updated_at = now()
where org_id = 'whiteport' and plugin_slug = 'tool_gmail';

-- 5. Seed Marten as a user (needed for vault entries)
insert into public.people (id, display_name, legal_name, primary_email, pronouns, person_type)
values ('00000000-0000-0000-0000-000000000001', 'Marten', 'Marten Angner', 'marten@angner.se', 'he/him', 'human')
on conflict (id) do update
set display_name = excluded.display_name, primary_email = excluded.primary_email;

insert into public.users (id, org_id, person_id, user_type, email, display_name, role, status)
values (
  '00000000-0000-0000-0000-000000000001',
  'whiteport',
  '00000000-0000-0000-0000-000000000001',
  'human',
  'marten@angner.se',
  'Marten',
  'owner',
  'active'
)
on conflict (id) do update
set email = excluded.email, display_name = excluded.display_name, role = excluded.role;
