-- Additive NeedStatus values for the automatic AI classification workflow.
-- Existing values are untouched — only two new ones are added, so every
-- other status filter already in place (dashboards, reports) keeps working.
-- Postgres requires each new enum value to be committed before it can be
-- used in the same session, so these run as separate statements.
ALTER TYPE "NeedStatus" ADD VALUE 'pending_ai_classification';
ALTER TYPE "NeedStatus" ADD VALUE 'ai_classification_failed';

-- Tracks the most recent classification attempt (success or failure) and,
-- when it failed, why — cleared and re-set on every Retry so they always
-- reflect the latest attempt only.
ALTER TABLE "needs"
  ADD COLUMN "classified_at" TIMESTAMPTZ(6),
  ADD COLUMN "classification_error" TEXT;
