-- Stop Realtime from broadcasting embedding vectors.
--
-- Background: EGRESS-INCIDENT-2026-09-18.md.
--
-- Realtime ships whatever columns the publication carries. `agent_space` is in
-- supabase_realtime with no column list, so every INSERT broadcast the whole
-- row -- including `embedding vector(1536)` and `visual_embedding vector(1024)`,
-- roughly 19 kB -- to every connected listener. There are five of them
-- (hooks/ds.js, hooks/conductor.js, hooks/orchestrator.js,
-- channel/design-space.ts, mcp-server/index.js), and they reconnect, so a
-- single agent message could cost several hundred kB of fan-out before any
-- client asked for anything.
--
-- None of those listeners reads a vector. They route on metadata and show
-- content. Postgres 15+ lets a publication carry a column list, so the vectors
-- simply stop leaving the database on this path.
--
-- Constraint respected: a publication column list must include the table's
-- replica identity. agent_space uses the default identity (primary key `id`),
-- which is first in the list below.
--
-- Not touched: the ivfflat indexes and the search functions. Vectors are still
-- stored and still searchable -- they are only no longer broadcast.

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'agent_space'
  ) then
    execute 'alter publication supabase_realtime drop table public.agent_space';
  end if;

  execute $sql$
    alter publication supabase_realtime add table public.agent_space (
      id,
      content,
      category,
      project,
      designer,
      client,
      topics,
      components,
      source,
      source_file,
      pattern_type,
      quality_score,
      pair_id,
      metadata,
      thread_id,
      created_at,
      updated_at
    )
  $sql$;
end
$$;
