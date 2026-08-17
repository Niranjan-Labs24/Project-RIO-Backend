-- RIO-NFR-002: stamp the consent copy version on each survey response so the
-- audit trail records which version of the privacy notice the citizen accepted.
ALTER TABLE "survey_responses" ADD COLUMN "consent_version" VARCHAR(32);
