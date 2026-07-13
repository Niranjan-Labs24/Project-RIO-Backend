-- Tenant tables keyed on org_id: fail-closed NULLIF policy (matches the reviewed foundation).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','consent_acceptances'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid);',
      t || '_org_isolation', t);
  END LOOP;
END $$;

-- Tenant-root: an org sees/writes only its own row (keyed on id). Enables the org-creation bootstrap.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations" FORCE ROW LEVEL SECURITY;
CREATE POLICY organisations_isolation ON "organisations"
  USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- audit_logs: append-only, RLS by organisation_id (nullable for system events).
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_isolation ON "audit_logs"
  USING (organisation_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Runtime grants for cnap_app (NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON "organisations","users","consent_acceptances" TO cnap_app;
GRANT SELECT, INSERT ON "audit_logs" TO cnap_app;                       -- append-only
GRANT SELECT ON "roles","role_permissions","consent_policies" TO cnap_app; -- reference, read-only

-- Cross-org read-only supervisor role (AD-15; used by runAsSupervisor in R4-R6).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cnap_supervisor') THEN
    CREATE ROLE cnap_supervisor WITH LOGIN PASSWORD 'cnap_supervisor_dev_pw' NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO cnap_supervisor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_supervisor;
-- Cross-org SELECT policies for the supervisor role (read everything; no write path).
CREATE POLICY organisations_supervisor_read ON "organisations" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY users_supervisor_read ON "users" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY consent_acceptances_supervisor_read ON "consent_acceptances" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY audit_logs_supervisor_read ON "audit_logs" FOR SELECT TO cnap_supervisor USING (true);
