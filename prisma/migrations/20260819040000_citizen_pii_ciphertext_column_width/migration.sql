-- RIO-NFR-002 follow-up: widen the encrypted citizen PII columns to TEXT.
--
-- 20260813000002_citizen_pii_encryption_setup switched contact/mobile to hold
-- ciphertext but left the widths sized for plaintext ("the contact/mobile
-- columns remain VARCHAR"). citizen-pii.crypto.ts emits
-- "<iv-hex>:<ciphertext-hex>" — 32 IV chars, a colon, then the AES-256-CBC
-- block-padded body — so the shortest value it can ever produce is 65 chars.
-- mobile VARCHAR(32) was therefore unsatisfiable for EVERY value, and each
-- citizen submission died on Prisma P2000 ("value too long for the column's
-- type") in CitizenService.submitResponse, surfacing as a 500.
--
-- contact VARCHAR(320) was survivable but not safe: it caps the plaintext
-- email at ~127 chars rather than the 320 the RFC allows, so a long address
-- would have hit the same wall.
--
-- TEXT rather than a wider VARCHAR: the stored length is a function of the
-- cipher's block padding, not of any business rule, so there is no honest
-- number to pick. Postgres stores VARCHAR(n) and TEXT identically, and both
-- unique indexes below (needId,contact / needId,mobile) work unchanged on
-- TEXT — this is a metadata-only change, no table rewrite.
ALTER TABLE "survey_responses" ALTER COLUMN "contact" TYPE TEXT;
ALTER TABLE "survey_responses" ALTER COLUMN "mobile" TYPE TEXT;

-- Re-state the column comments dropped-through from the earlier migration,
-- now recording the width rationale alongside the format.
COMMENT ON COLUMN "survey_responses"."contact" IS
  'AES-256-CBC encrypted email (format: <iv-hex>:<ciphertext-hex>). '
  'TEXT because the stored length tracks the ciphertext, not the plaintext. '
  'Encrypted by CitizenService via citizen-pii.crypto.ts using ENCRYPTION_KEY. '
  'Run scripts/encrypt-citizen-pii.ts to encrypt legacy plaintext rows.';

COMMENT ON COLUMN "survey_responses"."mobile" IS
  'AES-256-CBC encrypted mobile number (format: <iv-hex>:<ciphertext-hex>). '
  'TEXT because the shortest possible ciphertext is 65 chars. '
  'Encrypted by CitizenService via citizen-pii.crypto.ts using ENCRYPTION_KEY.';
