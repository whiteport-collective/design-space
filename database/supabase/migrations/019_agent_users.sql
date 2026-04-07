-- Migration 019: Seed agent users for Whiteport org
--
-- Access model:
--   - Agents inherit ALL tool access from their human delegate (tool_delegate).
--   - No per-agent tool_access lists. The human's connected tools are the ceiling.
--   - Skills remain agent-specific (domain expertise). But a human can ask any
--     agent to use any tool by name — the agent can comply if the delegate has access.
--   - domain: "wds" (product agents) or "business" (operations agents)

INSERT INTO public.users (id, org_id, person_id, user_type, email, display_name, role, status, agent_preferences) VALUES
  ('00000000-0000-0000-0000-000000000010', 'whiteport', NULL, 'agent', 'saga@agent.whiteport.com', 'Saga', 'agent', 'active',
    '{"tool_delegate": "00000000-0000-0000-0000-000000000001", "pronouns": "she/her", "icon": "📚", "domain": "wds"}'::jsonb),
  ('00000000-0000-0000-0000-000000000011', 'whiteport', NULL, 'agent', 'freya@agent.whiteport.com', 'Freya', 'agent', 'active',
    '{"tool_delegate": "00000000-0000-0000-0000-000000000001", "pronouns": "she/her", "icon": "✨", "domain": "wds"}'::jsonb),
  ('00000000-0000-0000-0000-000000000012', 'whiteport', NULL, 'agent', 'mimir@agent.whiteport.com', 'Mimir', 'agent', 'active',
    '{"tool_delegate": "00000000-0000-0000-0000-000000000001", "pronouns": "he/him", "icon": "🔨", "domain": "wds"}'::jsonb),
  ('00000000-0000-0000-0000-000000000013', 'whiteport', NULL, 'agent', 'idun@agent.whiteport.com', 'Idun', 'agent', 'active',
    '{"tool_delegate": "00000000-0000-0000-0000-000000000001", "pronouns": "she/her", "icon": "🍎", "domain": "wds"}'::jsonb),
  ('00000000-0000-0000-0000-000000000014', 'whiteport', NULL, 'agent', 'ivonne@agent.whiteport.com', 'Ivonne', 'agent', 'active',
    '{"tool_delegate": "00000000-0000-0000-0000-000000000001", "pronouns": "she/her", "icon": "💼", "domain": "business"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  agent_preferences = EXCLUDED.agent_preferences,
  role = EXCLUDED.role,
  status = EXCLUDED.status;

-- Org memberships
INSERT INTO public.user_memberships (user_id, org_id, role, status)
SELECT v.user_id, v.org_id, v.role, v.status
FROM (VALUES
  ('00000000-0000-0000-0000-000000000010'::uuid, 'whiteport', 'agent', 'active'),
  ('00000000-0000-0000-0000-000000000011'::uuid, 'whiteport', 'agent', 'active'),
  ('00000000-0000-0000-0000-000000000012'::uuid, 'whiteport', 'agent', 'active'),
  ('00000000-0000-0000-0000-000000000013'::uuid, 'whiteport', 'agent', 'active'),
  ('00000000-0000-0000-0000-000000000014'::uuid, 'whiteport', 'agent', 'active')
) AS v(user_id, org_id, role, status)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_memberships m WHERE m.user_id = v.user_id AND m.org_id = v.org_id
);
