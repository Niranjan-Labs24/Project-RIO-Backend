-- Enable and FORCE row-level security so even the table owner (cnap_owner) is
-- subject to policy. Runtime role cnap_app is NOBYPASSRLS.
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;

-- Fail-closed isolation: when app.current_org_id is unset, current_setting(..., true)
-- returns NULL, org_id = NULL is never true, so zero rows are visible/writable.
CREATE POLICY notes_org_isolation ON "notes"
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- Runtime privileges for the restricted role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "notes" TO cnap_app;
GRANT SELECT ON "organisations" TO cnap_app;
GRANT SELECT ON "users" TO cnap_app;
