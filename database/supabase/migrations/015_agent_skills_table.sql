-- Migration 015: agent_skills table
-- Declares which skills are available to which agents at which scope.
-- session-start returns the skill list alongside instructions so agents
-- know at boot time what they can invoke without further queries.
--
-- Scope resolution mirrors agent_instructions:
--   wds_default → org → client → project → repo
-- A null agent_id means the skill is available to all agents at that scope.

create table if not exists public.agent_skills (
  id uuid primary key default gen_random_uuid(),

  -- Which agent this skill belongs to (null = all agents)
  agent_id   text,

  -- Scope
  skill_level text not null check (skill_level in (
    'wds_default',
    'org',
    'client',
    'project',
    'repo'
  )),
  org_id    text,
  client_id text,
  project   text,
  repo      text,

  -- Skill identity
  skill_slug text not null,
  skill_name text not null,
  phase      int,
  description text,

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_skills_agent
  on public.agent_skills (agent_id, skill_level);

create unique index if not exists idx_agent_skills_unique
  on public.agent_skills (
    coalesce(agent_id, ''),
    skill_level,
    skill_slug,
    coalesce(org_id, ''),
    coalesce(project, ''),
    coalesce(repo, '')
  );

drop trigger if exists agent_skills_updated_at on public.agent_skills;
create trigger agent_skills_updated_at
  before update on public.agent_skills
  for each row execute function public.update_updated_at();

-- RLS (service role only — same pattern as other tables)
alter table public.agent_skills enable row level security;

drop policy if exists "agent_skills_select" on public.agent_skills;
drop policy if exists "agent_skills_insert" on public.agent_skills;
drop policy if exists "agent_skills_update" on public.agent_skills;
drop policy if exists "agent_skills_delete" on public.agent_skills;

create policy "agent_skills_select" on public.agent_skills for select using (true);
create policy "agent_skills_insert" on public.agent_skills for insert with check (true);
create policy "agent_skills_update" on public.agent_skills for update using (true);
create policy "agent_skills_delete" on public.agent_skills for delete using (true);

-- Seed: WDS default skills for all agents
insert into public.agent_skills (agent_id, skill_level, skill_slug, skill_name, phase, description) values
  ('saga',  'wds_default', 'saga-discovery',       'Product Brief Discovery',  1, 'Guide client through Product Brief creation via natural conversation'),
  ('saga',  'wds_default', 'saga-trigger-mapping',  'Trigger Map',              2, 'Build Trigger Map connecting business goals to user psychology'),
  ('freya', 'wds_default', 'ux-scenarios',          'UX Scenarios',             3, 'Turn Trigger Map into prioritized UX scenario set'),
  ('freya', 'wds_default', 'ux-design',             'UX Design',                4, 'Translate approved scenarios into implementation-ready page specs'),
  ('mimir', 'wds_default', 'mimir-implementation',  'Implementation',           5, 'Turn Freya spec into working code, one verified task at a time'),
  ('mimir', 'wds_default', 'mimir-orchestration',   'Orchestration (WDS-E)',    5, 'Coordinate parallel sub-agent implementation waves'),
  ('idun',  'wds_default', 'idun-qualification',    'Qualification',            1, 'Qualify new WDS engagement before setup'),
  ('idun',  'wds_default', 'idun-org-onboarding',   'Org Onboarding',           1, 'Turn approved qualification into org-level WDS setup'),
  ('idun',  'wds_default', 'idun-user-onboarding',  'User Onboarding',          1, 'Onboard individual user into configured WDS org')
on conflict do nothing;
