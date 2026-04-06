-- Migration 012: complete Agent Space boot support
-- Adds missing agent_presence fields needed by wrap/session-start and
-- restores backward compatibility for search_design_space during the rename window.

alter table public.agent_presence add column if not exists repo text;
alter table public.agent_presence add column if not exists session_id uuid;
alter table public.agent_presence add column if not exists session_start timestamptz;
alter table public.agent_presence add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.agent_presence add column if not exists last_status_report text;
alter table public.agent_presence add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_agent_presence_agent_name on public.agent_presence (agent_name);
create index if not exists idx_agent_presence_repo on public.agent_presence (repo);

drop trigger if exists agent_presence_updated_at on public.agent_presence;
create trigger agent_presence_updated_at
  before update on public.agent_presence
  for each row execute function public.update_updated_at();

drop function if exists public.search_agent_space(vector, float8, int, text, text, text);
create or replace function public.search_agent_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null
)
returns table (
  id uuid,
  content text,
  category text,
  project text,
  designer text,
  client text,
  topics text[],
  components text[],
  source text,
  source_file text,
  pattern_type text,
  quality_score real,
  pair_id uuid,
  metadata jsonb,
  thread_id uuid,
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    ds.id,
    ds.content,
    ds.category,
    ds.project,
    ds.designer,
    ds.client,
    ds.topics,
    ds.components,
    ds.source,
    ds.source_file,
    ds.pattern_type,
    ds.quality_score,
    ds.pair_id,
    ds.metadata,
    ds.thread_id,
    ds.created_at,
    1 - (ds.embedding <=> query_embedding) as similarity
  from public.agent_space ds
  where
    ds.embedding is not null
    and 1 - (ds.embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_designer is null or ds.designer = filter_designer)
  order by ds.embedding <=> query_embedding
  limit match_count;
end;
$$;

drop function if exists public.search_design_space(vector, float8, int, text, text, text);
create or replace function public.search_design_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null
)
returns table (
  id uuid,
  content text,
  category text,
  project text,
  designer text,
  client text,
  topics text[],
  components text[],
  source text,
  source_file text,
  pattern_type text,
  quality_score real,
  pair_id uuid,
  metadata jsonb,
  thread_id uuid,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select *
  from public.search_agent_space(
    query_embedding,
    similarity_threshold,
    match_count,
    filter_category,
    filter_project,
    filter_designer
  );
$$;
