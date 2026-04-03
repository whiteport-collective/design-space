-- Migration 008: Rename design_space → agent_space
-- Agent Space is the official product name.
-- Backward compat: view keeps old name alive for any existing callers.

-- Rename the table
alter table public.design_space rename to agent_space;

-- Rename indexes
alter index if exists idx_design_space_category rename to idx_agent_space_category;
alter index if exists idx_design_space_project rename to idx_agent_space_project;
alter index if exists idx_design_space_designer rename to idx_agent_space_designer;
alter index if exists idx_design_space_pair_id rename to idx_agent_space_pair_id;
alter index if exists idx_design_space_thread_id rename to idx_agent_space_thread_id;
alter index if exists idx_design_space_created_at rename to idx_agent_space_created_at;
alter index if exists idx_design_space_metadata rename to idx_agent_space_metadata;
alter index if exists idx_design_space_embedding rename to idx_agent_space_embedding;
alter index if exists idx_design_space_visual_embedding rename to idx_agent_space_visual_embedding;

-- Rename trigger
drop trigger if exists design_space_updated_at on public.agent_space;
create trigger agent_space_updated_at
  before update on public.agent_space
  for each row execute function public.update_updated_at();

-- Rename RLS policies
alter policy "design_space_select" on public.agent_space rename to "agent_space_select";
alter policy "design_space_insert" on public.agent_space rename to "agent_space_insert";
alter policy "design_space_update" on public.agent_space rename to "agent_space_update";

-- Update realtime publication
alter publication supabase_realtime drop table public.design_space;
alter publication supabase_realtime add table public.agent_space;

-- Rename search function
alter function if exists public.search_design_space rename to search_agent_space;

-- Backward compat: view so old callers still work during transition
create or replace view public.design_space as select * from public.agent_space;
