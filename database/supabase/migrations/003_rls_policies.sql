-- Row Level Security policies for Design Space
-- Default: open access via anon key (single-team deployment)
-- For multi-tenant: add user_project_access table and tighten policies

alter table public.design_space enable row level security;
alter table public.agent_presence enable row level security;

-- Design Space: read/write for authenticated and anon (service key controls access)
create policy "design_space_select" on public.design_space
  for select using (true);

create policy "design_space_insert" on public.design_space
  for insert with check (true);

create policy "design_space_update" on public.design_space
  for update using (true);

-- Agent Presence: read/write for all
create policy "agent_presence_select" on public.agent_presence
  for select using (true);

create policy "agent_presence_insert" on public.agent_presence
  for insert with check (true);

create policy "agent_presence_update" on public.agent_presence
  for update using (true);

-- Enable Realtime for agent messaging
alter publication supabase_realtime add table public.design_space;
