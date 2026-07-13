-- Public signup needs to INSERT into both "organisations" and "users" —
-- cnap_app previously only had SELECT on either (see 20260709140625_rls_policies).
GRANT INSERT ON "organisations" TO cnap_app;
GRANT INSERT ON "users" TO cnap_app;

-- "users" has FORCE ROW LEVEL SECURITY with a single ALL-commands policy
-- requiring org_id = app.current_org_id (20260710084255_rls_users_policy).
-- Login and signup's email-uniqueness check both need to find a user BY
-- EMAIL before any org context exists — structurally impossible under that
-- policy alone, by design (that's the isolation guarantee it enforces).
--
-- This adds a second, FOR SELECT-only, permissive policy. Postgres ORs
-- multiple permissive policies together for the same command, so this only
-- ever widens SELECT visibility, and only for a transaction that explicitly
-- sets app.allow_auth_lookup = 'true' — which is exactly one narrowly-scoped
-- repository method (auth.repository.ts's email lookup), never anything
-- else. It does not affect INSERT/UPDATE/DELETE, which remain governed
-- solely by users_org_isolation. NULLIF hardens against both an unset GUC
-- (NULL) and a reverted-to-empty GUC (''), matching the existing
-- fail-closed pattern from 20260710080508_rls_harden_empty_guc.
CREATE POLICY "users_auth_lookup" ON "users"
  FOR SELECT
  USING (NULLIF(current_setting('app.allow_auth_lookup', true), '') = 'true');
