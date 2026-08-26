-- RIO-FR-012 (Sprint 2): question versioning + Human Reviewer approval
-- (client-confirmed Q30/Q31, 2026-08-20). Purely additive — no existing
-- column touched, safe on a live DB.

ALTER TABLE "questions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "questions" ADD COLUMN "is_current_version" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "questions" ADD COLUMN "approval_status" VARCHAR(20) NOT NULL DEFAULT 'approved';
ALTER TABLE "questions" ADD COLUMN "previous_version_id" UUID;
ALTER TABLE "questions" ADD COLUMN "submitted_by" UUID;
ALTER TABLE "questions" ADD COLUMN "submitted_at" TIMESTAMPTZ;
ALTER TABLE "questions" ADD COLUMN "reviewed_by" UUID;
ALTER TABLE "questions" ADD COLUMN "reviewed_at" TIMESTAMPTZ;
ALTER TABLE "questions" ADD COLUMN "rejection_reason" TEXT;

ALTER TABLE "questions"
  ADD CONSTRAINT "questions_previous_version_id_fkey"
  FOREIGN KEY ("previous_version_id") REFERENCES "questions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The old two-column unique index (methodology_version_id, question_id) must
-- go: multiple version-rows now legitimately share that pair. Replaced with
-- a three-column unique index that includes version. (Created originally as
-- a plain unique INDEX, not a table CONSTRAINT — see
-- 20260812090000_methodology_version_scoped_questions — so DROP INDEX, not
-- DROP CONSTRAINT.)
DROP INDEX IF EXISTS "questions_methodology_version_id_question_id_key";
CREATE UNIQUE INDEX "questions_methodology_version_id_question_id_version_key"
  ON "questions" ("methodology_version_id", "question_id", "version");

CREATE INDEX "questions_methodology_version_id_question_id_is_current_ver_idx"
  ON "questions" ("methodology_version_id", "question_id", "is_current_version");
