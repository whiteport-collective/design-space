-- 030: Add covering indexes for 16 foreign keys flagged by the performance advisor.
-- Improves JOIN performance and FK cascade/constraint check speed.

CREATE INDEX IF NOT EXISTS idx_agent_channel_related_entry_id ON public.agent_channel(related_entry_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_superseded_by ON public.agent_knowledge(superseded_by);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_user_id ON public.agent_knowledge(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_message_reads_reader_user_id ON public.agent_message_reads(reader_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from_user_id ON public.agent_messages(from_user_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to_user_id ON public.agent_messages(to_user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_pairs_after_knowledge_id ON public.knowledge_feedback_pairs(after_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_pairs_before_knowledge_id ON public.knowledge_feedback_pairs(before_knowledge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_pairs_created_by_user_id ON public.knowledge_feedback_pairs(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_pairs_org_id ON public.knowledge_feedback_pairs(org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_state_org_id ON public.oauth_state(org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_state_user_id ON public.oauth_state(user_id);
CREATE INDEX IF NOT EXISTS idx_org_governance_profiles_updated_by ON public.org_governance_profiles(updated_by);
CREATE INDEX IF NOT EXISTS idx_org_plugin_installations_activated_by ON public.org_plugin_installations(activated_by);
CREATE INDEX IF NOT EXISTS idx_org_plugin_installations_plugin_slug ON public.org_plugin_installations(plugin_slug);
CREATE INDEX IF NOT EXISTS idx_telegram_users_user_id ON public.telegram_users(user_id);
