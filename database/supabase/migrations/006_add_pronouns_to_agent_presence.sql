-- Add pronouns column to agent_presence for proper agent addressing
alter table public.agent_presence add column if not exists pronouns text;
