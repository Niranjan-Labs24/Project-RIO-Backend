-- GAP-03 / AD-17: SurveyResponse.contact/.mobile switch from deterministic
-- AES-256-CBC to authenticated AES-256-GCM (random IV per encryption), so
-- the same plaintext no longer reliably produces the same ciphertext.
-- Equality/uniqueness therefore moves off the ciphertext columns onto new
-- keyed-HMAC blind-index columns (contact_blind_index/mobile_blind_index),
-- computed by CitizenService via computeBlindIndex() at write time.
--
-- Pre-launch: no real PII rows exist yet, so contact_blind_index can be
-- added NOT NULL with no backfill step.

-- DropIndex
DROP INDEX "survey_responses_need_id_contact_key";

-- DropIndex
DROP INDEX "survey_responses_need_id_mobile_key";

-- AlterTable
ALTER TABLE "survey_responses" ADD COLUMN     "contact_blind_index" CHAR(64) NOT NULL,
ADD COLUMN     "mobile_blind_index" CHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "survey_responses_need_id_contact_blind_index_key" ON "survey_responses"("need_id", "contact_blind_index");

-- CreateIndex
CREATE UNIQUE INDEX "survey_responses_need_id_mobile_blind_index_key" ON "survey_responses"("need_id", "mobile_blind_index");
