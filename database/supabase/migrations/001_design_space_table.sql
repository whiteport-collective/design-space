-- Design Space: primary knowledge table with semantic + visual embeddings
-- Requires pgvector extension

create extension if not exists vector with schema extensions;

create table if not exists public.design_space (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  category text not null default 'general',
  project text,
  designer text,
  client text,
  topics text[] default '{}',
  components text[] default '{}',
  source text,
  source_file text,

  -- Semantic embedding (OpenAI text-embedding-3-small via OpenRouter, 1536d)
  embedding vector(1536),

  -- Visual embedding (Voyage AI voyage-multimodal-3, 1024d)
  visual_embedding vector(1024),

  -- Visual pattern metadata
  pattern_type text, -- baseline, inspiration, delta, rejected, approved, conditional
  quality_score numeric,
  pair_id uuid,      -- Links before/after feedback pairs

  -- Agent messaging metadata (stored as JSONB for flexibility)
  metadata jsonb default '{}',
  thread_id uuid,

  -- Timestamps
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes for common queries
create index if not exists idx_design_space_category on public.design_space (category);
create index if not exists idx_design_space_project on public.design_space (project);
create index if not exists idx_design_space_designer on public.design_space (designer);
create index if not exists idx_design_space_pair_id on public.design_space (pair_id);
create index if not exists idx_design_space_thread_id on public.design_space (thread_id);
create index if not exists idx_design_space_created_at on public.design_space (created_at desc);
create index if not exists idx_design_space_metadata on public.design_space using gin (metadata);

-- Vector similarity indexes (IVFFlat for fast approximate search)
create index if not exists idx_design_space_embedding on public.design_space
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists idx_design_space_visual_embedding on public.design_space
  using ivfflat (visual_embedding vector_cosine_ops) with (lists = 100);

-- Updated_at trigger
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger design_space_updated_at
  before update on public.design_space
  for each row execute function update_updated_at();
