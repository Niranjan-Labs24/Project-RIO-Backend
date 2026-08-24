-- RIO-FR-012 (Sprint 2) — fixes a pre-existing gap: cnap_app only ever had
-- SELECT on "questions" (see 20260716211500_ai_survey_flow), never
-- INSERT/UPDATE, even though QuestionsService.update/deactivate/reactivate
-- mutate this table. Discovered via a real end-to-end smoke test of the
-- new versioning/approval flow (2026-08-20), not previously caught because
-- these endpoints had never actually been exercised against a DB with real
-- role grants. "questions" has no orgId/RLS policy (global reference
-- data), so a plain grant is correct here — no policy to add alongside it.
GRANT INSERT, UPDATE ON "questions" TO cnap_app;
