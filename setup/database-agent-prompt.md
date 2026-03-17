# Design Space — Database Setup Prompt

Paste this entire prompt into Claude Code (or any agent with the Supabase MCP configured).

---

## Prompt (copy everything below this line)

---

I need you to set up a Design Space database on Supabase. Please complete these steps:

**Step 1 — Find or create a project**

Use the Supabase MCP to list my projects. If I have a project I want to use, I'll tell you. Otherwise ask me if you should create a new one (region: eu-north-1 is recommended for Europe).

**Step 2 — Run the 4 SQL migrations in order**

Use `execute_sql` for each migration. Run them in the exact order below.

### Migration 1 — Main table

```sql
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
  embedding vector(1536),
  visual_embedding vector(1024),
  pattern_type text,
  quality_score numeric,
  pair_id uuid,
  metadata jsonb default '{}',
  thread_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_design_space_category on public.design_space (category);
create index if not exists idx_design_space_project on public.design_space (project);
create index if not exists idx_design_space_designer on public.design_space (designer);
create index if not exists idx_design_space_pair_id on public.design_space (pair_id);
create index if not exists idx_design_space_thread_id on public.design_space (thread_id);
create index if not exists idx_design_space_created_at on public.design_space (created_at desc);
create index if not exists idx_design_space_metadata on public.design_space using gin (metadata);
create index if not exists idx_design_space_embedding on public.design_space
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists idx_design_space_visual_embedding on public.design_space
  using ivfflat (visual_embedding vector_cosine_ops) with (lists = 100);

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
```

### Migration 2 — Agent presence table

```sql
create table if not exists public.agent_presence (
  agent_id text primary key,
  agent_name text,
  model text,
  platform text default 'claude-code',
  framework text,
  project text,
  working_on text,
  workspace text,
  capabilities text[] default '{}',
  tools_available text[] default '{}',
  context_window jsonb,
  status text default 'online',
  last_heartbeat timestamptz default now(),
  created_at timestamptz default now()
);

create index if not exists idx_agent_presence_project on public.agent_presence (project);
create index if not exists idx_agent_presence_heartbeat on public.agent_presence (last_heartbeat desc);
```

### Migration 3 — Row Level Security

```sql
alter table public.design_space enable row level security;
alter table public.agent_presence enable row level security;

create policy "design_space_select" on public.design_space for select using (true);
create policy "design_space_insert" on public.design_space for insert with check (true);
create policy "design_space_update" on public.design_space for update using (true);

create policy "agent_presence_select" on public.agent_presence for select using (true);
create policy "agent_presence_insert" on public.agent_presence for insert with check (true);
create policy "agent_presence_update" on public.agent_presence for update using (true);

alter publication supabase_realtime add table public.design_space;
```

### Migration 4 — Search functions

```sql
create or replace function search_design_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null
)
returns table (
  id uuid, content text, category text, project text, designer text,
  client text, topics text[], components text[], source text, source_file text,
  pattern_type text, quality_score numeric, pair_id uuid, metadata jsonb,
  thread_id uuid, created_at timestamptz, similarity float
)
language plpgsql as $$
begin
  return query
  select ds.id, ds.content, ds.category, ds.project, ds.designer, ds.client,
    ds.topics, ds.components, ds.source, ds.source_file, ds.pattern_type,
    ds.quality_score, ds.pair_id, ds.metadata, ds.thread_id, ds.created_at,
    1 - (ds.embedding <=> query_embedding) as similarity
  from public.design_space ds
  where ds.embedding is not null
    and 1 - (ds.embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_designer is null or ds.designer = filter_designer)
  order by ds.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function search_visual_similarity(
  query_embedding vector(1024),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_pattern_type text default null
)
returns table (
  id uuid, content text, category text, project text, designer text,
  pattern_type text, pair_id uuid, created_at timestamptz, similarity float
)
language plpgsql as $$
begin
  return query
  select ds.id, ds.content, ds.category, ds.project, ds.designer,
    ds.pattern_type, ds.pair_id, ds.created_at,
    1 - (ds.visual_embedding <=> query_embedding) as similarity
  from public.design_space ds
  where ds.visual_embedding is not null
    and 1 - (ds.visual_embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_pattern_type is null or ds.pattern_type = filter_pattern_type)
  order by ds.visual_embedding <=> query_embedding
  limit match_count;
end;
$$;
```

**Step 3 — Deploy the 7 Edge Functions**

Deploy each function from `design-space/database/supabase/functions/` using the Supabase MCP or CLI:

```
agent-messages
capture-design-space
capture-feedback-pair
capture-visual
search-design-space
search-preference-patterns
search-visual-similarity
```

If your agent has the Supabase MCP `deploy_edge_function` tool, use it for each function.
If not, run: `./setup.sh YOUR-PROJECT-REF` from the design-space root (requires Supabase CLI).

**Step 4 — Set Edge Function secrets**

In the Supabase dashboard → Edge Functions → Secrets:

| Secret | Required | Purpose |
|--------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | Semantic embeddings |
| `VOYAGE_API_KEY` | Optional | Visual embeddings |

**Step 5 — Output credentials**

When done, give me:
```
DESIGN_SPACE_URL=https://YOUR-PROJECT-REF.supabase.co
DESIGN_SPACE_ANON_KEY=<anon key from Supabase dashboard → Settings → API>
```

I'll put these in `design-space/.env`.
