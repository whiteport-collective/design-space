-- Migration 013: make repo part of repo_files identity
-- This allows the same path to exist in multiple repos under one project.

update public.repo_files
set repo = ''
where repo is null;

alter table public.repo_files
  alter column repo set default '';

alter table public.repo_files
  alter column repo set not null;

alter table public.repo_files
  drop constraint if exists repo_files_org_id_project_path_key;

alter table public.repo_files
  drop constraint if exists repo_files_org_id_project_repo_path_key;

alter table public.repo_files
  add constraint repo_files_org_id_project_repo_path_key
  unique (org_id, project, repo, path);

drop index if exists idx_repo_files_org_project;
create index if not exists idx_repo_files_org_project_repo
  on public.repo_files (org_id, project, repo);
