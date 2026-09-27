-- Migration 021: align agent_skills with live schema and add scope resolution

alter table public.agent_skills
  add column if not exists client_id text,
  add column if not exists version text,
  add column if not exists content text;

alter table public.agent_skills
  drop constraint if exists agent_skills_skill_level_check;

alter table public.agent_skills
  add constraint agent_skills_skill_level_check
  check (skill_level in (
    'wds_default',
    'org',
    'client',
    'project',
    'repo',
    'shared',
    'user'
  ));

drop index if exists public.idx_agent_skills_unique;
create unique index if not exists idx_agent_skills_unique
on public.agent_skills (
  coalesce(agent_id, ''),
  skill_level,
  skill_slug,
  coalesce(org_id, ''),
  coalesce(client_id, ''),
  coalesce(project, ''),
  coalesce(repo, '')
);

create or replace function public.resolve_agent_skills(
  p_agent_id text,
  p_org_id text default null,
  p_client_id text default null,
  p_project text default null,
  p_repo text default null
)
returns setof public.agent_skills
language sql
stable
as $$
  select *
  from public.agent_skills
  where (
      agent_id is null
      or agent_id = '*'
      or agent_id = p_agent_id
    )
    and (
      skill_level = 'wds_default'
      or (skill_level in ('org', 'shared') and org_id = p_org_id)
      or (skill_level = 'client' and org_id = p_org_id and client_id = p_client_id)
      or (skill_level = 'project' and org_id = p_org_id and project = p_project)
      or (skill_level = 'repo' and org_id = p_org_id and project = p_project and repo = p_repo)
    )
  order by
    case skill_level
      when 'wds_default' then 1
      when 'org'         then 2
      when 'shared'      then 2
      when 'client'      then 3
      when 'project'     then 4
      when 'repo'        then 5
      when 'user'        then 6
      else 99
    end,
    updated_at asc;
$$;
