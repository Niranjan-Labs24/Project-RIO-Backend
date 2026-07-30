-- Two additive, purely-nullable changes — no backfill needed, existing rows
-- are simply left NULL and read as "not captured," never as zero/empty.
--
-- 1. survey_responses.age_bracket: a citizen's self-reported age bracket
--    (never exact age/DOB), mandatory going forward on new public-survey
--    submissions (see citizen.contract.ts), but nullable here since
--    responses collected before this feature existed have no value.
-- 2. surveys.rejection_reason_code: a structured reason code recorded
--    alongside the existing free-text approver_comments whenever a survey
--    is rejected (see SurveysService.rejectSurvey) — REJ-99 (Other) is the
--    only code that also requires approver_comments to be filled in.

-- CreateEnum
CREATE TYPE "AgeBracket" AS ENUM ('15-24', '25-34', '35-44', '45-54', '55-64', '65+', 'prefer_not_to_say');

-- CreateEnum
CREATE TYPE "RejectionReasonCode" AS ENUM ('REJ-01', 'REJ-02', 'REJ-03', 'REJ-04', 'REJ-05', 'REJ-06', 'REJ-07', 'REJ-99');

-- AlterTable
ALTER TABLE "survey_responses" ADD COLUMN     "age_bracket" "AgeBracket";

-- AlterTable
ALTER TABLE "surveys" ADD COLUMN     "rejection_reason_code" "RejectionReasonCode";
