-- Migration 011: optional user-level instruction extension
-- This is not part of the core five-level WDS-E hierarchy.
-- It allows personal overlays to be layered on top when a user_id is supplied.

alter table public.agent_instructions add column if not exists user_id text;

alter table public.agent_instructions
  drop constraint if exists agent_instructions_skill_level_check;

alter table public.agent_instructions
  add constraint agent_instructions_skill_level_check
  check (skill_level in ('wds_default', 'org', 'client', 'project', 'repo', 'user'));

drop index if exists public.idx_agent_instructions_unique_scope;
create unique index if not exists idx_agent_instructions_unique_scope
  on public.agent_instructions (
    agent_id,
    model_target,
    skill_level,
    coalesce(org_id, ''),
    coalesce(client_id, ''),
    coalesce(project, ''),
    coalesce(repo, ''),
    coalesce(user_id, '')
  );

create or replace function public.resolve_agent_instructions(
  p_agent_id     text,
  p_model_target text default 'claude',
  p_org_id       text default null,
  p_client_id    text default null,
  p_project      text default null,
  p_repo         text default null,
  p_user_id      text default null
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
      or (skill_level = 'user'    and user_id = p_user_id)
    )
  order by
    case skill_level
      when 'wds_default' then 1
      when 'org'         then 2
      when 'client'      then 3
      when 'project'     then 4
      when 'repo'        then 5
      when 'user'        then 6
    end,
    updated_at asc;
$$;
