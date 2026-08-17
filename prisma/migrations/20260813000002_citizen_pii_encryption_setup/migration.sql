-- RIO-NFR-002: pgcrypto extension for citizen PII encryption at rest.
-- The contact/mobile columns remain VARCHAR; ciphertext is stored as
-- "<iv-hex>:<ciphertext-hex>" produced by citizen-pii.crypto.ts (AES-256-CBC,
-- deterministic IV derived via HMAC so dedup queries continue to work).
-- Existing plaintext rows are detected by isEncrypted() and left readable
-- until a one-off re-encryption script is run.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

COMMENT ON COLUMN "survey_responses"."contact" IS
  'AES-256-CBC encrypted email (format: <iv-hex>:<ciphertext-hex>). '
  'Encrypted by CitizenService via citizen-pii.crypto.ts using ENCRYPTION_KEY. '
  'Run scripts/encrypt-citizen-pii.ts to encrypt legacy plaintext rows.';

COMMENT ON COLUMN "survey_responses"."mobile" IS
  'AES-256-CBC encrypted mobile number (format: <iv-hex>:<ciphertext-hex>). '
  'Encrypted by CitizenService via citizen-pii.crypto.ts using ENCRYPTION_KEY.';
