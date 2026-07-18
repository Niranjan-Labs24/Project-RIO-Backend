-- CreateTable
-- Renamed from "survey_responses" to "survey_builder_responses" — that name
-- already belongs to the Publish Survey/Citizen flow's SurveyResponse table
-- (org/study/survey-link/contact-scoped; backs the live citizen OTP
-- submission flow, Response Quality, Priority, Reports). This is a
-- genuinely different, unrelated table (Survey Builder's own survey_id +
-- answers shape), so it needs its own name rather than colliding.
CREATE TABLE "survey_builder_responses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "survey_id" UUID NOT NULL,
    "answers" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_builder_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "survey_builder_responses_survey_id_idx" ON "survey_builder_responses"("survey_id");

-- AddForeignKey
ALTER TABLE "survey_builder_responses" ADD CONSTRAINT "survey_builder_responses_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
