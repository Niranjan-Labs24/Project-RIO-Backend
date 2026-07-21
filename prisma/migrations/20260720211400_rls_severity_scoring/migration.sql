-- Enable Row Level Security on the new tenant tables
ALTER TABLE "response_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "response_answers" FORCE ROW LEVEL SECURITY;

ALTER TABLE "response_severity_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "response_severity_scores" FORCE ROW LEVEL SECURITY;

ALTER TABLE "score_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "score_rollups" FORCE ROW LEVEL SECURITY;

-- Create isolation policies for cnap_app
CREATE POLICY response_answers_org_isolation ON "response_answers"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY response_severity_scores_org_isolation ON "response_severity_scores"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY score_rollups_org_isolation ON "score_rollups"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Grant select/insert/update/delete permissions to cnap_app
GRANT SELECT, INSERT, UPDATE, DELETE ON "response_answers", "response_severity_scores", "score_rollups" TO cnap_app;
-- Grant select/insert/update/delete permission to read-only tables (methodology_versions and scoring_lookups)
GRANT SELECT, INSERT, UPDATE, DELETE ON "methodology_versions", "scoring_lookups" TO cnap_app;

-- Grant select permission to cnap_supervisor
GRANT SELECT ON "response_answers", "response_severity_scores", "score_rollups", "methodology_versions", "scoring_lookups" TO cnap_supervisor;

-- Create supervisor read policies
CREATE POLICY response_answers_supervisor_read ON "response_answers" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY response_severity_scores_supervisor_read ON "response_severity_scores" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY score_rollups_supervisor_read ON "score_rollups" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY methodology_versions_supervisor_read ON "methodology_versions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY scoring_lookups_supervisor_read ON "scoring_lookups" FOR SELECT TO cnap_supervisor USING (true);
