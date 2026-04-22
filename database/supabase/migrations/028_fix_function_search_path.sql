-- 028: Pin search_path on 7 functions to prevent search-path hijack.

ALTER FUNCTION public.linkedin_activity_cache_update_search() SET search_path = pg_catalog, public;
ALTER FUNCTION public.linkedin_message_cache_update_search() SET search_path = pg_catalog, public;
ALTER FUNCTION public.prune_tool_usage_log() SET search_path = pg_catalog, public;
ALTER FUNCTION public.resolve_agent_instructions(text,text,text,text,text,text,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.resolve_agent_skills(text,text,text,text,text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.search_agent_space(vector,double precision,integer,text,text,text,boolean) SET search_path = pg_catalog, public;
ALTER FUNCTION public.search_design_space(vector,double precision,integer,text,text,text,boolean) SET search_path = pg_catalog, public;
