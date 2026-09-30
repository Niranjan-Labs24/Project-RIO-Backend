-- UAT-09 — surveys inherit Target Sector, geography and methodology version
-- from their parent Study.

-- Snapshot of the inherited Study values, frozen at publish (null for drafts,
-- which read the Study live). See Survey.inheritedSnapshot.
ALTER TABLE "surveys" ADD COLUMN "inherited_snapshot" JSONB;

-- Existing still-editable surveys (DRAFT / REJECTED) take their Study's
-- methodology version, the same value a newly created survey now inherits.
-- SUBMITTED / APPROVED / PUBLISHED / SUPERSEDED surveys are left exactly as
-- they were reviewed and published.
UPDATE "surveys" AS s
SET "methodology_version" = mv."version"
FROM "studies" AS st
JOIN "methodology_versions" AS mv ON mv."id" = st."methodology_version_id"
WHERE s."study_id" = st."id"
  AND s."status" IN ('DRAFT', 'REJECTED')
  AND s."methodology_version" IS DISTINCT FROM mv."version";
