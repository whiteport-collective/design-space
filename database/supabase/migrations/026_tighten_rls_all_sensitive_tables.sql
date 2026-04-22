-- 026: Replace all `TO public USING (true)` policies with service_role-only.
-- Edge functions run as service_role and keep working. Anon key can no longer
-- read/write these tables directly.
--
-- Context: Supabase security advisor flagged 17 tables with `rls_policy_always_true`.
-- Additional 8 tables (linkedin_*, telegram_*, tool_usage_log) had RLS disabled —
-- enabled in a prior hotfix; this migration adds explicit service_role policies so
-- the intent is visible in source.

DO $$
DECLARE
  t text;
  p text;
  tables text[] := ARRAY[
    'agent_instructions','agent_knowledge','agent_message_reads','agent_messages',
    'agent_skills','api_keys','knowledge_feedback_pairs','oauth_state',
    'org_governance_profiles','org_plugin_installations','orgs','people',
    'plugin_catalog','repo_files','user_memberships','user_vault','users',
    'open_glass_briefings',
    'linkedin_message_cache','linkedin_activity_cache','linkedin_signal_rules',
    'tool_usage_log','telegram_users','telegram_sessions','telegram_logs','telegram_messages'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    FOR p IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p, t);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY service_role_full_access ON public.%I
         FOR ALL TO service_role USING (true) WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;
