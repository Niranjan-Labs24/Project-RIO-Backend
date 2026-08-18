-- RIO-FR-012 (Sprint 2): question deactivation + Study Type stub.
-- Purely additive — no existing column touched, safe on a live DB.
ALTER TABLE "questions" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "questions" ADD COLUMN "deactivated_at" TIMESTAMPTZ;
ALTER TABLE "questions" ADD COLUMN "deactivated_by" UUID;

ALTER TABLE "studies" ADD COLUMN "study_type" VARCHAR(100);
