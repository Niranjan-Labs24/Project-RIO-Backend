-- UAT DST-04 — a survey link has a mandatory start and end date. The end date
-- reuses expires_at; the start date is new. Nullable: links created before
-- this change have no start date and stay open as they are.
--
-- IF NOT EXISTS: an earlier, unmerged branch (sprint3-bugfix, migration
-- 20261103000000_dst04_survey_link_starts_at) adds the same column, and some
-- databases already have it. This keeps both orders safe.
ALTER TABLE "public_survey_links" ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMPTZ(6);
