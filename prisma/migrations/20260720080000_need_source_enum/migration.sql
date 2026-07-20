-- RIO-FR-001: Need.source becomes a system-assigned enum instead of a
-- free-text field a submitter could type anything into. Existing rows carry
-- arbitrary historical values (manual entries, imported rows' own "source"
-- column) with no reliable way to recover which literal creation path each
-- one actually came from — best-effort keyword mapping below, defaulting to
-- manual_entry, since that's the only path this column has ever
-- unconditionally defaulted to.
CREATE TYPE "NeedSource" AS ENUM ('manual_entry', 'file_upload', 'citizen_input', 'field_survey');

ALTER TABLE "needs"
  ALTER COLUMN "source" TYPE "NeedSource" USING (
    CASE
      WHEN "source" ILIKE 'manual%' THEN 'manual_entry'
      WHEN "source" ILIKE '%import%' OR "source" ILIKE '%upload%' OR "source" ILIKE '%bulk%' THEN 'file_upload'
      WHEN "source" ILIKE '%citizen%' THEN 'citizen_input'
      WHEN "source" ILIKE '%survey%' OR "source" ILIKE '%field%' OR "source" ILIKE '%visit%'
        OR "source" ILIKE '%meeting%' OR "source" ILIKE '%report%' OR "source" ILIKE '%assessment%' THEN 'field_survey'
      ELSE 'manual_entry'
    END
  )::"NeedSource";
