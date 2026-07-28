-- Structured rural/urban settlement on survey responses, so rural/urban
-- demographic reporting can group on it directly (mirrors the Gender enum).
CREATE TYPE "SettlementType" AS ENUM ('rural', 'urban');
ALTER TABLE "survey_responses" ADD COLUMN "settlement_type" "SettlementType";
