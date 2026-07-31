-- Survey-scoped reports: RPT01 (Individual Survey Report) and RPT15 (Combined
-- Survey + Dashboard Report) are generated from ONE survey, not a whole study.
-- Without this column two surveys under the same study produce two reports that
-- are indistinguishable in the list and untraceable back to their source.
--
-- Nullable by design: org-wide types (RPT02/RPT12) legitimately have no survey,
-- and historical rows predate the column.

-- AlterTable
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "survey_id" UUID;

-- AddForeignKey
-- SET NULL rather than CASCADE: a released report is an archival record and must
-- survive the deletion of the survey it was generated from (orgId/studyId still
-- scope it). Matches Report.studyId's own nullable-FK intent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_survey_id_fkey'
  ) THEN
    ALTER TABLE "reports"
      ADD CONSTRAINT "reports_survey_id_fkey"
      FOREIGN KEY ("survey_id") REFERENCES "surveys"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reports_survey_id_idx" ON "reports"("survey_id");

-- Backfill: only where it is unambiguous. A study with exactly one survey means
-- every study-scoped report under it can only have come from that survey. A
-- study with several surveys is genuinely unknowable after the fact — those rows
-- stay NULL rather than being guessed at.
-- array_agg(...)[1] rather than MIN(id): Postgres has no min(uuid) aggregate,
-- and HAVING COUNT(*) = 1 already guarantees there is exactly one element.
UPDATE "reports" r
SET "survey_id" = one."survey_id"
FROM (
  SELECT "study_id", (array_agg("id"))[1] AS "survey_id"
  FROM "surveys"
  GROUP BY "study_id"
  HAVING COUNT(*) = 1
) one
WHERE r."study_id" = one."study_id"
  AND r."survey_id" IS NULL
  AND r."study_id" IS NOT NULL;
