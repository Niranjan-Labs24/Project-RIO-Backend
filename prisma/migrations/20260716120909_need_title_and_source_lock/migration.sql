-- Adds Need.title.
--
-- Not a bare `ADD COLUMN ... NOT NULL`: that fails on a non-empty table. A
-- Need's studyId is unique (1:1 with Study), so every existing row has exactly
-- one Study to take its title from — backfilling is both possible and correct,
-- which is why this ends NOT NULL rather than leaving the column permanently
-- nullable.
--
-- The NO FORCE dance around the UPDATE is load-bearing. `needs` is under
-- FORCE ROW LEVEL SECURITY (see 20260714120000_week2_data_capture), and its
-- policy keys off `app.current_org_id`, which is unset during a migration.
-- FORCE means even the table owner is subject to the policy, so a plain UPDATE
-- here matches *zero rows* — silently. The subsequent SET NOT NULL then fails,
-- because DDL validation isn't filtered by RLS and does see the real rows.
-- Lifting FORCE for the duration of the backfill is what makes the two agree.
--
-- The `source` half of this migration's name is contract-only: source becomes
-- system-set by dropping it from CreateNeedBody/UpdateNeedBody
-- (additionalProperties:false makes that a hard 400). The column itself is
-- unchanged, so there is deliberately no SQL for it here.

-- AlterTable
ALTER TABLE "needs" ADD COLUMN "title" VARCHAR(300);

-- Backfill from the parent Study, with RLS lifted so the UPDATE can see rows.
ALTER TABLE "needs" NO FORCE ROW LEVEL SECURITY;

UPDATE "needs" SET "title" = "studies"."title"
  FROM "studies"
  WHERE "needs"."study_id" = "studies"."id";

-- The FK makes an orphan Need impossible, but guard anyway so SET NOT NULL
-- below can't fail on a stray null.
UPDATE "needs" SET "title" = '(untitled)' WHERE "title" IS NULL;

ALTER TABLE "needs" FORCE ROW LEVEL SECURITY;

ALTER TABLE "needs" ALTER COLUMN "title" SET NOT NULL;
