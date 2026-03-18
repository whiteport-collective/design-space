-- Tighten open RLS policies: restrict write access to service_role only
-- Edge functions run as service_role, so this adds a real security layer
-- while keeping the same functionality.

-- agent_presence: restrict INSERT and UPDATE to service_role
DROP POLICY IF EXISTS "agent_presence_insert" ON public.agent_presence;
CREATE POLICY "agent_presence_insert" ON public.agent_presence
  FOR INSERT TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "agent_presence_update" ON public.agent_presence;
CREATE POLICY "agent_presence_update" ON public.agent_presence
  FOR UPDATE TO service_role
  USING (true) WITH CHECK (true);

-- agent_presence: SELECT stays open (not flagged, agents need to read)
-- (agent_presence_select unchanged)

-- design_space: restrict service_role_full_access to actual service_role
DROP POLICY IF EXISTS "service_role_full_access" ON public.design_space;
CREATE POLICY "service_role_full_access" ON public.design_space
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- thoughts: restrict to service_role
DROP POLICY IF EXISTS "Service role full access" ON public.thoughts;
CREATE POLICY "service_role_full_access" ON public.thoughts
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- dixie_messages: add service_role policy (RLS enabled but had no policies)
CREATE POLICY "service_role_full_access" ON public.dixie_messages
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
