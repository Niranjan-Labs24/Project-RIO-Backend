-- Apply the same fail-closed RLS isolation to "users" as "notes" (see the
-- 20260709140625_rls_policies and 20260710080508_rls_harden_empty_guc
-- migrations): every tenant table that carries org_id gets FORCE ROW LEVEL
-- SECURITY plus a NULLIF-hardened policy so an unset OR empty-string
-- app.current_org_id GUC uniformly yields zero rows instead of erroring.
--
-- NOTE: "organisations" is the tenant ROOT (it has no org_id column — it is
-- keyed by its own id) and is intentionally EXEMPT from this per-org-id
-- policy; it already only grants SELECT to cnap_app (see 20260709140625_rls_policies).
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY users_org_isolation ON "users"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
