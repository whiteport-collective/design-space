-- Migration 010: agent_instructions table
-- Stores compiled WDS agent instructions at 5 skill levels.
-- Resolution order: wds_default -> org -> client -> project -> repo
--
-- session-start fetches all matching rows for a given scope and returns them
-- ordered so the calling agent can merge top-down.

create table if not exists public.agent_instructions (
  id uuid primary key default gen_random_uuid(),

  -- Which agent and model this instruction targets
  agent_id     text not null,
  model_target text not null default 'claude',

  -- Skill hierarchy level
  skill_level text not null check (skill_level in (
    'wds_default',
    'org',
    'client',
    'project',
    'repo'
  )),

  -- Scope identifiers (null = applies to all at that level)
  org_id    text,
  client_id text,
  project   text,
  repo      text,

  -- Content
  content text not null,
  version text,

  -- Timestamps
  updated_at timestamptz not null default now()
);

-- Indexes for session-start resolution queries
create index if not exists idx_agent_instructions_agent
  on public.agent_instructions (agent_id, model_target);
create index if not exists idx_agent_instructions_level
  on public.agent_instructions (skill_level);
create index if not exists idx_agent_instructions_scope
  on public.agent_instructions (org_id, client_id, project, repo);
create unique index if not exists idx_agent_instructions_unique_scope
  on public.agent_instructions (
    agent_id,
    model_target,
    skill_level,
    coalesce(org_id, ''),
    coalesce(client_id, ''),
    coalesce(project, ''),
    coalesce(repo, '')
  );

-- Auto-update timestamp
drop trigger if exists agent_instructions_updated_at on public.agent_instructions;
create trigger agent_instructions_updated_at
  before update on public.agent_instructions
  for each row execute function public.update_updated_at();

-- RLS
alter table public.agent_instructions enable row level security;

drop policy if exists "agent_instructions_select" on public.agent_instructions;
drop policy if exists "agent_instructions_insert" on public.agent_instructions;
drop policy if exists "agent_instructions_update" on public.agent_instructions;
drop policy if exists "agent_instructions_delete" on public.agent_instructions;

create policy "agent_instructions_select" on public.agent_instructions for select using (true);
create policy "agent_instructions_insert" on public.agent_instructions for insert with check (true);
create policy "agent_instructions_update" on public.agent_instructions for update using (true);
create policy "agent_instructions_delete" on public.agent_instructions for delete using (true);

-- Helper: resolve full instruction chain for a given agent + scope.
-- Includes wildcard agent rows (`agent_id = '*'`) for shared instructions.
create or replace function public.resolve_agent_instructions(
  p_agent_id     text,
  p_model_target text default 'claude',
  p_org_id       text default null,
  p_client_id    text default null,
  p_project      text default null,
  p_repo         text default null
)
returns setof public.agent_instructions
language sql
stable
as $$
  select *
  from public.agent_instructions
  where agent_id in (p_agent_id, '*')
    and model_target = p_model_target
    and (
      skill_level = 'wds_default'
      or (skill_level = 'org'     and org_id = p_org_id)
      or (skill_level = 'client'  and org_id = p_org_id and client_id = p_client_id)
      or (skill_level = 'project' and org_id = p_org_id and project = p_project)
      or (skill_level = 'repo'    and org_id = p_org_id and project = p_project and repo = p_repo)
    )
  order by
    case skill_level
      when 'wds_default' then 1
      when 'org'         then 2
      when 'client'      then 3
      when 'project'     then 4
      when 'repo'        then 5
    end,
    updated_at asc;
$$;
