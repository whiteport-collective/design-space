-- Migration 009: repo_files table
-- Stores arbitrary file content per org/project/path.
-- Enables /wrap to push design-process/ folder to Agent Space,
-- and /start to pull it back — eliminating _bmad/ local dependency.

create table if not exists public.repo_files (
  id uuid primary key default gen_random_uuid(),

  -- Tenancy
  org_id text not null default 'whiteport',

  -- Scope
  project text not null,
  repo    text,             -- optional: repo name within project (e.g. sharif-webshop)

  -- Content
  path         text not null,  -- e.g. design-process/A-Product-Brief/product-brief.md
  content      text not null,
  content_type text not null default 'text/markdown',

  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One file per (org, project, path)
  unique(org_id, project, path)
);

-- Indexes
create index idx_repo_files_org_project on public.repo_files (org_id, project);
create index idx_repo_files_path on public.repo_files (path);
create index idx_repo_files_updated_at on public.repo_files (updated_at desc);

-- Auto-update timestamp
create trigger repo_files_updated_at
  before update on public.repo_files
  for each row execute function public.update_updated_at();

-- RLS: open access via service key (matches existing pattern)
alter table public.repo_files enable row level security;

create policy "repo_files_select" on public.repo_files for select using (true);
create policy "repo_files_insert" on public.repo_files for insert with check (true);
create policy "repo_files_update" on public.repo_files for update using (true);
create policy "repo_files_delete" on public.repo_files for delete using (true);
