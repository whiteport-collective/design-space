create table if not exists public.open_glass_briefings (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  project text not null,
  repo text not null default '',
  view_slug text not null default 'open-glass',
  audience_scope text not null default 'admin-dashboard',
  payload jsonb not null,
  generated_at timestamptz not null default now(),
  freshness_at timestamptz not null default now(),
  superseded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_open_glass_briefings_scope_latest
  on public.open_glass_briefings (org_id, project, repo, view_slug, audience_scope, generated_at desc);

create index if not exists idx_open_glass_briefings_active
  on public.open_glass_briefings (org_id, project, repo, view_slug, audience_scope)
  where superseded_at is null;

alter table public.open_glass_briefings enable row level security;
