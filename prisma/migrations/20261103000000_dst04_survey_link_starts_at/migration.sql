-- UAT DST-04 — survey links get a mandatory start date (and end date) on create.
--
-- Nullable on purpose: links created before DST-04 have no start date and
-- stay open from their creation time, exactly as before. New links always
-- set it (PublicSurveysService.createLink). Table-level grants on
-- public_survey_links (cnap_app / cnap_supervisor) already cover a new column.
ALTER TABLE "public_survey_links" ADD COLUMN "starts_at" TIMESTAMPTZ(6);
