-- Methodology approval gate (RBAC-002 / client-confirmed): publish() must
-- require a System Reviewer's approval of the current edit.
ALTER TYPE "MethodologyStatus" ADD VALUE 'pending_approval';
ALTER TYPE "MethodologyStatus" ADD VALUE 'approved';

ALTER TABLE "methodology_configs" ADD COLUMN "reviewed_by" UUID;
ALTER TABLE "methodology_configs" ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);
ALTER TABLE "methodology_configs" ADD COLUMN "review_notes" TEXT;
