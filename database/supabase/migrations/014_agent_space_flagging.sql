-- Migration 014: non-destructive knowledge flagging for Agent Space
-- Lets agents mark stale or incorrect knowledge without deleting history.

alter table public.agent_space
  add column if not exists flagged boolean not null default false;

alter table public.agent_space
  add column if not exists superseded_by uuid references public.agent_space(id) on delete set null;

create index if not exists idx_agent_space_flagged on public.agent_space (flagged);
create index if not exists idx_agent_space_superseded_by on public.agent_space (superseded_by);

drop function if exists public.search_agent_space(vector, float8, int, text, text, text);
drop function if exists public.search_agent_space(vector, float8, int, text, text, text, boolean);
create or replace function public.search_agent_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null,
  filter_include_flagged boolean default false
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
  flagged boolean,
  superseded_by uuid,
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
    ds.flagged,
    ds.superseded_by,
    1 - (ds.embedding <=> query_embedding) as similarity
  from public.agent_space ds
  where
    ds.embedding is not null
    and 1 - (ds.embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_designer is null or ds.designer = filter_designer)
    and (filter_include_flagged or not ds.flagged)
  order by ds.embedding <=> query_embedding
  limit match_count;
end;
$$;

drop function if exists public.search_design_space(vector, float8, int, text, text, text);
drop function if exists public.search_design_space(vector, float8, int, text, text, text, boolean);
create or replace function public.search_design_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null,
  filter_include_flagged boolean default false
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
  flagged boolean,
  superseded_by uuid,
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
    filter_designer,
    filter_include_flagged
  );
$$;
