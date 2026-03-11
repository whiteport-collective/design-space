-- Agent presence tracking for cross-LLM, cross-IDE discovery

create table if not exists public.agent_presence (
  agent_id text primary key,
  agent_name text,
  model text,
  platform text default 'claude-code',
  framework text,
  project text,
  working_on text,
  workspace text,
  capabilities text[] default '{}',
  tools_available text[] default '{}',
  context_window jsonb,
  status text default 'online',
  last_heartbeat timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists idx_agent_presence_project on public.agent_presence (project);
create index if not exists idx_agent_presence_heartbeat on public.agent_presence (last_heartbeat desc);
