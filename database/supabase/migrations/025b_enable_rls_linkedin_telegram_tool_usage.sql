-- 025b: Hotfix — enable RLS on 8 tables that had it disabled in production.
-- Flagged by Supabase security advisor (rls_disabled_in_public).
-- Edge functions use service_role which bypasses RLS, so no policies needed
-- for current functionality. Explicit service_role policies are added in
-- migration 026.

ALTER TABLE public.linkedin_message_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linkedin_activity_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linkedin_signal_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_messages ENABLE ROW LEVEL SECURITY;
