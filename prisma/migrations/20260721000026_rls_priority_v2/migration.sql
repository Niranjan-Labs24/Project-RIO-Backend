-- Enable Row Level Security on village_priority_assessments
ALTER TABLE "village_priority_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "village_priority_assessments" FORCE ROW LEVEL SECURITY;

-- Create isolation policies for cnap_app
CREATE POLICY village_priority_assessments_org_isolation ON "village_priority_assessments"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Grant select/insert/update/delete permissions to cnap_app
GRANT SELECT, INSERT, UPDATE, DELETE ON "village_priority_assessments" TO cnap_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "domain_priority_configs" TO cnap_app;

-- Grant select permission to cnap_supervisor
GRANT SELECT ON "village_priority_assessments", "domain_priority_configs" TO cnap_supervisor;

-- Create supervisor read policies
CREATE POLICY village_priority_assessments_supervisor_read ON "village_priority_assessments" FOR SELECT TO cnap_supervisor USING (true);
