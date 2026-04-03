-- Migration 011: Add user level to skill hierarchy
-- Users can save personal skills into Agent Space — stored, synced, and
-- applied on top of all org/client/project/repo levels.
-- Resolution order: wds_default → org → client → project → repo → user

-- Add user_id column
alter table public.agent_instructions add column if not exists user_id text;

-- Update the skill_level check constraint to include 'user'
alter table public.agent_instructions
  drop constraint if exists agent_instructions_skill_level_check;

alter table public.agent_instructions
  add constraint agent_instructions_skill_level_check
  check (skill_level in ('wds_default', 'org', 'client', 'project', 'repo', 'user'));

-- Update the unique constraint to include user_id
alter table public.agent_instructions
  drop constraint if exists agent_instructions_agent_id_model_target_skill_level_coalesce_key;

-- Recreate with user_id included
alter table public.agent_instructions
  add constraint agent_instructions_unique_scope
  unique (agent_id, model_target, skill_level,
          coalesce(org_id, ''), coalesce(client_id, ''),
          coalesce(project, ''), coalesce(repo, ''), coalesce(user_id, ''));

-- Update resolve function to include user level
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
language sql stable as $$
  select * from public.agent_instructions
  where agent_id = p_agent_id
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
    end;
$$;
