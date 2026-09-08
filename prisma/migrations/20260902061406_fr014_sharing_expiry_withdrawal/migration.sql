-- RIO-FR-014 (client Q30): owner-set expiry and owner withdrawal of
-- already-approved sharing access, for both Study and Report sharing.
ALTER TYPE "SharingStatus" ADD VALUE IF NOT EXISTS 'withdrawn';

ALTER TABLE "sharing_requests"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "withdrawn_by" UUID,
  ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMPTZ(6);

ALTER TABLE "report_sharing_requests"
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "withdrawn_by" UUID,
  ADD COLUMN IF NOT EXISTS "withdrawn_at" TIMESTAMPTZ(6);
