-- Security hardening: RLS on agent_presence + search_path on all public functions

-- 1. Enable RLS on agent_presence (was missing despite being in migration file)
alter table public.agent_presence enable row level security;

-- 2. Open policies for agent_presence (single-team deployment — anon key controls access)
drop policy if exists "agent_presence_select" on public.agent_presence;
drop policy if exists "agent_presence_insert" on public.agent_presence;
drop policy if exists "agent_presence_update" on public.agent_presence;

create policy "agent_presence_select" on public.agent_presence
  for select using (true);

create policy "agent_presence_insert" on public.agent_presence
  for insert with check (true);

create policy "agent_presence_update" on public.agent_presence
  for update using (true);

-- 3. Fix mutable search_path on all public functions
alter function public.design_space_stats()
  set search_path = public;

alter function public.recent_design_space(integer, text, text)
  set search_path = public;

alter function public.recent_thoughts(integer)
  set search_path = public;

alter function public.search_design_space(vector, double precision, integer, text, text, text)
  set search_path = public;

alter function public.search_preference_patterns(vector, vector, text, text, double precision, double precision, integer)
  set search_path = public;

alter function public.search_thoughts(vector, integer, text, text, text)
  set search_path = public;

alter function public.search_visual_similarity(vector, double precision, integer, text, text)
  set search_path = public;

alter function public.search_visual_similarity(vector, double precision, integer, text, text, text, text)
  set search_path = public;

alter function public.thought_stats()
  set search_path = public;

alter function public.update_design_space_timestamp()
  set search_path = public;

alter function public.update_updated_at()
  set search_path = public;
