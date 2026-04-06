-- Migration 016: enterprise foundation for identity, governance, and future table split
-- Additive only. Existing agent_space/agent_presence/repo_files flows keep working.

-- 1. Agent presence becomes org-aware without breaking legacy callers
alter table public.agent_presence
  add column if not exists org_id text not null default 'whiteport';

create index if not exists idx_agent_presence_org on public.agent_presence (org_id);
create index if not exists idx_agent_presence_org_repo on public.agent_presence (org_id, repo);

-- 2. Enterprise identity foundation
create table if not exists public.orgs (
  id text primary key,
  name text not null,
  slug text not null unique,
  status text not null default 'active',
  deployment_mode text not null check (deployment_mode in ('shared', 'dedicated')),
  primary_region text,
  governance_profile_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  legal_name text,
  primary_email text,
  pronouns text,
  person_type text not null default 'human' check (person_type in ('human', 'service-contact')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.orgs(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  external_auth_subject text,
  user_type text not null default 'human' check (user_type in ('human', 'service', 'agent')),
  email text,
  display_name text not null,
  avatar_url text,
  preferred_language text,
  locale text,
  role text,
  client_type text check (client_type in ('internal', 'client', 'partner')),
  expertise_areas text[] not null default '{}',
  notification_settings jsonb not null default '{}'::jsonb,
  agent_preferences jsonb not null default '{}'::jsonb,
  default_project text,
  default_repo text,
  project_access_depth text,
  trust_level jsonb not null default '{}'::jsonb,
  consent jsonb not null default '{}'::jsonb,
  retention_settings jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'invited', 'suspended', 'revoked')),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, external_auth_subject)
);

create table if not exists public.user_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  org_id text not null references public.orgs(id) on delete cascade,
  role text not null,
  client_id text,
  project text,
  repo text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.orgs(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  label text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- 3. Governance and plugin activation
create table if not exists public.plugin_catalog (
  plugin_slug text primary key,
  display_name text not null,
  version text not null,
  category text not null,
  dependencies text[] not null default '{}',
  default_enabled boolean not null default false,
  config_schema jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.org_governance_profiles (
  org_id text primary key references public.orgs(id) on delete cascade,
  source_path text,
  raw_document text,
  policy_json jsonb not null default '{}'::jsonb,
  parsed_version text,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.org_plugin_installations (
  id uuid primary key default gen_random_uuid(),
  org_id text not null references public.orgs(id) on delete cascade,
  plugin_slug text not null references public.plugin_catalog(plugin_slug) on delete cascade,
  status text not null default 'active' check (status in ('planned', 'active', 'disabled', 'error')),
  config jsonb not null default '{}'::jsonb,
  activated_by uuid references public.users(id) on delete set null,
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, plugin_slug)
);

-- 4. Split-ready tables (not yet used by all edge functions)
create table if not exists public.agent_knowledge (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'whiteport' references public.orgs(id) on delete cascade,
  project text,
  repo text,
  user_id uuid references public.users(id) on delete set null,
  agent_id text,
  title text,
  content text not null,
  category text not null,
  knowledge_type text not null default 'text' check (knowledge_type in ('text', 'visual', 'feedback', 'protocol')),
  topics text[] not null default '{}',
  components text[] not null default '{}',
  source text,
  source_file text,
  pattern_type text,
  quality_score numeric,
  embedding vector(1536),
  visual_embedding vector(1024),
  flagged boolean not null default false,
  superseded_by uuid references public.agent_knowledge(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_feedback_pairs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'whiteport' references public.orgs(id) on delete cascade,
  before_knowledge_id uuid not null references public.agent_knowledge(id) on delete cascade,
  after_knowledge_id uuid not null references public.agent_knowledge(id) on delete cascade,
  reasoning text not null,
  created_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'whiteport' references public.orgs(id) on delete cascade,
  project text,
  repo text,
  thread_id uuid not null,
  from_agent text not null,
  from_user_id uuid references public.users(id) on delete set null,
  to_agent text,
  to_user_id uuid references public.users(id) on delete set null,
  message_type text not null,
  title text,
  content text not null,
  priority text not null default 'normal',
  status text,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  result text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_message_reads (
  message_id uuid not null references public.agent_messages(id) on delete cascade,
  reader_agent_id text not null,
  reader_user_id uuid references public.users(id) on delete set null,
  disposition text not null check (disposition in ('handled', 'snoozed', 'read')),
  read_at timestamptz,
  snooze_until timestamptz,
  primary key (message_id, reader_agent_id)
);

-- 5. Indexes
create index if not exists idx_people_email on public.people (primary_email);

create index if not exists idx_users_org on public.users (org_id);
create index if not exists idx_users_person on public.users (person_id);
create index if not exists idx_users_email on public.users (email);
create index if not exists idx_users_org_subject on public.users (org_id, external_auth_subject);
create index if not exists idx_users_status on public.users (status);

create index if not exists idx_user_memberships_user on public.user_memberships (user_id);
create index if not exists idx_user_memberships_scope on public.user_memberships (org_id, client_id, project, repo);

create index if not exists idx_api_keys_org on public.api_keys (org_id);
create index if not exists idx_api_keys_user on public.api_keys (user_id);
create index if not exists idx_api_keys_active on public.api_keys (org_id, revoked_at);

create index if not exists idx_plugin_catalog_category on public.plugin_catalog (category);
create index if not exists idx_org_plugin_installations_org on public.org_plugin_installations (org_id);
create index if not exists idx_org_plugin_installations_status on public.org_plugin_installations (org_id, status);

create index if not exists idx_agent_knowledge_scope on public.agent_knowledge (org_id, project, repo);
create index if not exists idx_agent_knowledge_category on public.agent_knowledge (category);
create index if not exists idx_agent_knowledge_created_at on public.agent_knowledge (created_at desc);
create index if not exists idx_agent_knowledge_embedding on public.agent_knowledge
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists idx_agent_knowledge_visual_embedding on public.agent_knowledge
  using ivfflat (visual_embedding vector_cosine_ops) with (lists = 100);

create index if not exists idx_agent_messages_scope on public.agent_messages (org_id, project, repo);
create index if not exists idx_agent_messages_thread on public.agent_messages (thread_id);
create index if not exists idx_agent_messages_to_agent on public.agent_messages (to_agent);
create index if not exists idx_agent_messages_created_at on public.agent_messages (created_at desc);
create index if not exists idx_agent_message_reads_reader on public.agent_message_reads (reader_agent_id, disposition);

-- 6. Updated-at triggers
drop trigger if exists orgs_updated_at on public.orgs;
create trigger orgs_updated_at
  before update on public.orgs
  for each row execute function public.update_updated_at();

drop trigger if exists people_updated_at on public.people;
create trigger people_updated_at
  before update on public.people
  for each row execute function public.update_updated_at();

drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at
  before update on public.users
  for each row execute function public.update_updated_at();

drop trigger if exists user_memberships_updated_at on public.user_memberships;
create trigger user_memberships_updated_at
  before update on public.user_memberships
  for each row execute function public.update_updated_at();

drop trigger if exists plugin_catalog_updated_at on public.plugin_catalog;
create trigger plugin_catalog_updated_at
  before update on public.plugin_catalog
  for each row execute function public.update_updated_at();

drop trigger if exists org_governance_profiles_updated_at on public.org_governance_profiles;
create trigger org_governance_profiles_updated_at
  before update on public.org_governance_profiles
  for each row execute function public.update_updated_at();

drop trigger if exists org_plugin_installations_updated_at on public.org_plugin_installations;
create trigger org_plugin_installations_updated_at
  before update on public.org_plugin_installations
  for each row execute function public.update_updated_at();

drop trigger if exists agent_knowledge_updated_at on public.agent_knowledge;
create trigger agent_knowledge_updated_at
  before update on public.agent_knowledge
  for each row execute function public.update_updated_at();

drop trigger if exists agent_messages_updated_at on public.agent_messages;
create trigger agent_messages_updated_at
  before update on public.agent_messages
  for each row execute function public.update_updated_at();

-- 7. RLS
alter table public.orgs enable row level security;
alter table public.people enable row level security;
alter table public.users enable row level security;
alter table public.user_memberships enable row level security;
alter table public.api_keys enable row level security;
alter table public.plugin_catalog enable row level security;
alter table public.org_governance_profiles enable row level security;
alter table public.org_plugin_installations enable row level security;
alter table public.agent_knowledge enable row level security;
alter table public.knowledge_feedback_pairs enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_message_reads enable row level security;

drop policy if exists "orgs_select" on public.orgs;
drop policy if exists "orgs_insert" on public.orgs;
drop policy if exists "orgs_update" on public.orgs;
drop policy if exists "orgs_delete" on public.orgs;
create policy "orgs_select" on public.orgs for select using (true);
create policy "orgs_insert" on public.orgs for insert with check (true);
create policy "orgs_update" on public.orgs for update using (true);
create policy "orgs_delete" on public.orgs for delete using (true);

drop policy if exists "people_select" on public.people;
drop policy if exists "people_insert" on public.people;
drop policy if exists "people_update" on public.people;
drop policy if exists "people_delete" on public.people;
create policy "people_select" on public.people for select using (true);
create policy "people_insert" on public.people for insert with check (true);
create policy "people_update" on public.people for update using (true);
create policy "people_delete" on public.people for delete using (true);

drop policy if exists "users_select" on public.users;
drop policy if exists "users_insert" on public.users;
drop policy if exists "users_update" on public.users;
drop policy if exists "users_delete" on public.users;
create policy "users_select" on public.users for select using (true);
create policy "users_insert" on public.users for insert with check (true);
create policy "users_update" on public.users for update using (true);
create policy "users_delete" on public.users for delete using (true);

drop policy if exists "user_memberships_select" on public.user_memberships;
drop policy if exists "user_memberships_insert" on public.user_memberships;
drop policy if exists "user_memberships_update" on public.user_memberships;
drop policy if exists "user_memberships_delete" on public.user_memberships;
create policy "user_memberships_select" on public.user_memberships for select using (true);
create policy "user_memberships_insert" on public.user_memberships for insert with check (true);
create policy "user_memberships_update" on public.user_memberships for update using (true);
create policy "user_memberships_delete" on public.user_memberships for delete using (true);

drop policy if exists "api_keys_select" on public.api_keys;
drop policy if exists "api_keys_insert" on public.api_keys;
drop policy if exists "api_keys_update" on public.api_keys;
drop policy if exists "api_keys_delete" on public.api_keys;
create policy "api_keys_select" on public.api_keys for select using (true);
create policy "api_keys_insert" on public.api_keys for insert with check (true);
create policy "api_keys_update" on public.api_keys for update using (true);
create policy "api_keys_delete" on public.api_keys for delete using (true);

drop policy if exists "plugin_catalog_select" on public.plugin_catalog;
drop policy if exists "plugin_catalog_insert" on public.plugin_catalog;
drop policy if exists "plugin_catalog_update" on public.plugin_catalog;
drop policy if exists "plugin_catalog_delete" on public.plugin_catalog;
create policy "plugin_catalog_select" on public.plugin_catalog for select using (true);
create policy "plugin_catalog_insert" on public.plugin_catalog for insert with check (true);
create policy "plugin_catalog_update" on public.plugin_catalog for update using (true);
create policy "plugin_catalog_delete" on public.plugin_catalog for delete using (true);

drop policy if exists "org_governance_profiles_select" on public.org_governance_profiles;
drop policy if exists "org_governance_profiles_insert" on public.org_governance_profiles;
drop policy if exists "org_governance_profiles_update" on public.org_governance_profiles;
drop policy if exists "org_governance_profiles_delete" on public.org_governance_profiles;
create policy "org_governance_profiles_select" on public.org_governance_profiles for select using (true);
create policy "org_governance_profiles_insert" on public.org_governance_profiles for insert with check (true);
create policy "org_governance_profiles_update" on public.org_governance_profiles for update using (true);
create policy "org_governance_profiles_delete" on public.org_governance_profiles for delete using (true);

drop policy if exists "org_plugin_installations_select" on public.org_plugin_installations;
drop policy if exists "org_plugin_installations_insert" on public.org_plugin_installations;
drop policy if exists "org_plugin_installations_update" on public.org_plugin_installations;
drop policy if exists "org_plugin_installations_delete" on public.org_plugin_installations;
create policy "org_plugin_installations_select" on public.org_plugin_installations for select using (true);
create policy "org_plugin_installations_insert" on public.org_plugin_installations for insert with check (true);
create policy "org_plugin_installations_update" on public.org_plugin_installations for update using (true);
create policy "org_plugin_installations_delete" on public.org_plugin_installations for delete using (true);

drop policy if exists "agent_knowledge_select" on public.agent_knowledge;
drop policy if exists "agent_knowledge_insert" on public.agent_knowledge;
drop policy if exists "agent_knowledge_update" on public.agent_knowledge;
drop policy if exists "agent_knowledge_delete" on public.agent_knowledge;
create policy "agent_knowledge_select" on public.agent_knowledge for select using (true);
create policy "agent_knowledge_insert" on public.agent_knowledge for insert with check (true);
create policy "agent_knowledge_update" on public.agent_knowledge for update using (true);
create policy "agent_knowledge_delete" on public.agent_knowledge for delete using (true);

drop policy if exists "knowledge_feedback_pairs_select" on public.knowledge_feedback_pairs;
drop policy if exists "knowledge_feedback_pairs_insert" on public.knowledge_feedback_pairs;
drop policy if exists "knowledge_feedback_pairs_update" on public.knowledge_feedback_pairs;
drop policy if exists "knowledge_feedback_pairs_delete" on public.knowledge_feedback_pairs;
create policy "knowledge_feedback_pairs_select" on public.knowledge_feedback_pairs for select using (true);
create policy "knowledge_feedback_pairs_insert" on public.knowledge_feedback_pairs for insert with check (true);
create policy "knowledge_feedback_pairs_update" on public.knowledge_feedback_pairs for update using (true);
create policy "knowledge_feedback_pairs_delete" on public.knowledge_feedback_pairs for delete using (true);

drop policy if exists "agent_messages_select" on public.agent_messages;
drop policy if exists "agent_messages_insert" on public.agent_messages;
drop policy if exists "agent_messages_update" on public.agent_messages;
drop policy if exists "agent_messages_delete" on public.agent_messages;
create policy "agent_messages_select" on public.agent_messages for select using (true);
create policy "agent_messages_insert" on public.agent_messages for insert with check (true);
create policy "agent_messages_update" on public.agent_messages for update using (true);
create policy "agent_messages_delete" on public.agent_messages for delete using (true);

drop policy if exists "agent_message_reads_select" on public.agent_message_reads;
drop policy if exists "agent_message_reads_insert" on public.agent_message_reads;
drop policy if exists "agent_message_reads_update" on public.agent_message_reads;
drop policy if exists "agent_message_reads_delete" on public.agent_message_reads;
create policy "agent_message_reads_select" on public.agent_message_reads for select using (true);
create policy "agent_message_reads_insert" on public.agent_message_reads for insert with check (true);
create policy "agent_message_reads_update" on public.agent_message_reads for update using (true);
create policy "agent_message_reads_delete" on public.agent_message_reads for delete using (true);

-- 8. Seed the current Whiteport org and the current plugin inventory
insert into public.orgs (id, name, slug, deployment_mode, primary_region)
values ('whiteport', 'Whiteport', 'whiteport', 'shared', 'eu-north')
on conflict (id) do update
set
  name = excluded.name,
  slug = excluded.slug,
  deployment_mode = excluded.deployment_mode,
  primary_region = excluded.primary_region;

insert into public.plugin_catalog (
  plugin_slug,
  display_name,
  version,
  category,
  dependencies,
  default_enabled,
  config_schema
) values
  ('agent_messages', 'Agent Messages', '1', 'core', '{}', true, '{}'::jsonb),
  ('agent_presence', 'Agent Presence', '1', 'core', '{}', true, '{}'::jsonb),
  ('agent_knowledge', 'Agent Knowledge', '1', 'core', '{}', true, '{}'::jsonb),
  ('session_start', 'Session Start', '1', 'core', '{"agent_messages","agent_presence","agent_knowledge"}', true, '{}'::jsonb),
  ('identity_access', 'Identity Access', '1', 'platform', '{}', true, '{}'::jsonb),
  ('governance', 'Governance', '1', 'platform', '{"identity_access"}', true, '{}'::jsonb),
  ('repo_files', 'Repo Files', '1', 'plugin', '{}', false, '{}'::jsonb),
  ('work_orders', 'Work Orders', '1', 'plugin', '{"agent_messages"}', false, '{}'::jsonb),
  ('skills', 'Skills', '1', 'plugin', '{"agent_knowledge"}', false, '{}'::jsonb),
  ('feedback_learning', 'Feedback Learning', '1', 'plugin', '{"agent_knowledge"}', false, '{}'::jsonb),
  ('visual_memory', 'Visual Memory', '1', 'plugin', '{"agent_knowledge"}', false, '{}'::jsonb),
  ('external_intake', 'External Intake', '1', 'plugin', '{"agent_messages"}', false, '{}'::jsonb),
  ('people', 'People', '1', 'plugin', '{"identity_access"}', false, '{}'::jsonb),
  ('users', 'Users', '1', 'plugin', '{"identity_access","people"}', false, '{}'::jsonb)
on conflict (plugin_slug) do update
set
  display_name = excluded.display_name,
  version = excluded.version,
  category = excluded.category,
  dependencies = excluded.dependencies,
  default_enabled = excluded.default_enabled,
  config_schema = excluded.config_schema,
  updated_at = now();

insert into public.org_governance_profiles (
  org_id,
  policy_json,
  parsed_version
) values (
  'whiteport',
  '{
    "identity_provider": "github",
    "identity_provider_reason": "Defaulted during enterprise foundation migration pending explicit qualification review",
    "storage_backend": "supabase",
    "git_provider": "github",
    "plugin_policy": {
      "repo_files": "active",
      "skills": "active",
      "feedback_learning": "active",
      "visual_memory": "active",
      "external_intake": "active",
      "people": "active",
      "users": "active"
    }
  }'::jsonb,
  'v1'
)
on conflict (org_id) do update
set
  policy_json = excluded.policy_json,
  parsed_version = excluded.parsed_version,
  updated_at = now();

insert into public.org_plugin_installations (
  org_id,
  plugin_slug,
  status,
  activated_at
) values
  ('whiteport', 'repo_files', 'active', now()),
  ('whiteport', 'skills', 'active', now()),
  ('whiteport', 'feedback_learning', 'active', now()),
  ('whiteport', 'visual_memory', 'active', now()),
  ('whiteport', 'external_intake', 'active', now()),
  ('whiteport', 'people', 'active', now()),
  ('whiteport', 'users', 'active', now())
on conflict (org_id, plugin_slug) do update
set
  status = excluded.status,
  activated_at = excluded.activated_at,
  updated_at = now();
