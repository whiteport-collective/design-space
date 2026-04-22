-- 027: Convert SECURITY DEFINER views to security_invoker so RLS of the
-- querying user is enforced, not the view owner's.

ALTER VIEW public.design_space SET (security_invoker = on);
ALTER VIEW public.tool_usage_daily SET (security_invoker = on);
