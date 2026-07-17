-- CreateTable
CREATE TABLE "survey_responses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "survey_id" UUID NOT NULL,
    "answers" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "survey_responses_survey_id_idx" ON "survey_responses"("survey_id");

-- AddForeignKey
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
