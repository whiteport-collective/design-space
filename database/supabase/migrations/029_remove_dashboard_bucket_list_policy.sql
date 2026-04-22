-- 029: Drop broad "Public read access" policy on storage.objects for the
-- `dashboard` bucket. Public bucket object URLs (/public/...) still work
-- without this policy — only bucket listing/enumeration is removed.

DROP POLICY IF EXISTS "Public read access" ON storage.objects;
