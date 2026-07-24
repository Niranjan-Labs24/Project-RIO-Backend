-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "analytical_category" VARCHAR(100),
ADD COLUMN     "conditional_rule" JSONB,
ADD COLUMN     "is_scoreable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "measurement_mode" VARCHAR(64) NOT NULL DEFAULT 'SINGLE_SELECT',
ADD COLUMN     "methodology_version_id" UUID,
ADD COLUMN     "priority_weight" DECIMAL(5,2),
ADD COLUMN     "scoring_lookup_key" VARCHAR(150),
ADD COLUMN     "severity_direction" VARCHAR(64);

-- AlterTable
ALTER TABLE "response_quality_results" ALTER COLUMN "missing_fields" DROP DEFAULT;

-- CreateTable
CREATE TABLE "methodology_versions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" VARCHAR(200) NOT NULL,
    "version" VARCHAR(100) NOT NULL,
    "status" VARCHAR(64) NOT NULL DEFAULT 'DRAFT',
    "description" TEXT,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "methodology_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_lookups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "methodology_version_id" UUID NOT NULL,
    "question_id" VARCHAR(64) NOT NULL,
    "lookup_type" VARCHAR(64) NOT NULL,
    "option_id" VARCHAR(100),
    "option_order" INTEGER,
    "severity_score" DECIMAL(5,2),
    "numeric_floor" DECIMAL(10,2),
    "numeric_ceiling" DECIMAL(10,2),
    "severity_direction" VARCHAR(64),
    "is_excluded" BOOLEAN NOT NULL DEFAULT false,
    "exclusion_reason" VARCHAR(64),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "scoring_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "response_answers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "survey_response_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "village_id" VARCHAR(150),
    "respondent_id" VARCHAR(255),
    "question_id" VARCHAR(64) NOT NULL,
    "answer_option_id" VARCHAR(100),
    "answer_numeric_value" DECIMAL(15,4),
    "answer_text" TEXT,
    "answer_option_ids" JSONB,
    "is_applicable" BOOLEAN NOT NULL DEFAULT true,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "response_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "response_severity_scores" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "response_answer_id" UUID NOT NULL,
    "survey_response_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "village_id" VARCHAR(150),
    "question_id" VARCHAR(64) NOT NULL,
    "methodology_version_id" UUID NOT NULL,
    "scoring_lookup_id" UUID,
    "raw_answer_snapshot" JSONB NOT NULL,
    "severity_score" DECIMAL(5,2),
    "score_status" VARCHAR(64) NOT NULL,
    "exclusion_reason" VARCHAR(64),
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculation_version" VARCHAR(64) NOT NULL,

    CONSTRAINT "response_severity_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_rollups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "village_id" VARCHAR(150),
    "methodology_version_id" UUID NOT NULL,
    "rollup_level" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(150) NOT NULL,
    "entity_name_snapshot" VARCHAR(300) NOT NULL,
    "severity_score" DECIMAL(5,2),
    "valid_response_count" INTEGER NOT NULL,
    "excluded_response_count" INTEGER NOT NULL,
    "dont_know_count" INTEGER NOT NULL,
    "dont_know_rate" DECIMAL(5,4) NOT NULL,
    "not_applicable_count" INTEGER NOT NULL,
    "confidence_level" VARCHAR(64) NOT NULL,
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculation_version" VARCHAR(64) NOT NULL,

    CONSTRAINT "score_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "methodology_versions_version_key" ON "methodology_versions"("version");

-- CreateIndex
CREATE INDEX "scoring_lookups_methodology_version_id_idx" ON "scoring_lookups"("methodology_version_id");

-- CreateIndex
CREATE INDEX "scoring_lookups_question_id_idx" ON "scoring_lookups"("question_id");

-- CreateIndex
CREATE INDEX "response_answers_org_id_idx" ON "response_answers"("org_id");

-- CreateIndex
CREATE INDEX "response_answers_survey_response_id_idx" ON "response_answers"("survey_response_id");

-- CreateIndex
CREATE INDEX "response_answers_survey_id_idx" ON "response_answers"("survey_id");

-- CreateIndex
CREATE INDEX "response_answers_study_id_idx" ON "response_answers"("study_id");

-- CreateIndex
CREATE INDEX "response_severity_scores_org_id_idx" ON "response_severity_scores"("org_id");

-- CreateIndex
CREATE INDEX "response_severity_scores_response_answer_id_idx" ON "response_severity_scores"("response_answer_id");

-- CreateIndex
CREATE INDEX "response_severity_scores_survey_response_id_idx" ON "response_severity_scores"("survey_response_id");

-- CreateIndex
CREATE INDEX "response_severity_scores_survey_id_idx" ON "response_severity_scores"("survey_id");

-- CreateIndex
CREATE INDEX "response_severity_scores_study_id_idx" ON "response_severity_scores"("study_id");

-- CreateIndex
CREATE INDEX "score_rollups_org_id_idx" ON "score_rollups"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "score_rollups_study_id_survey_id_village_id_methodology_ver_key" ON "score_rollups"("study_id", "survey_id", "village_id", "methodology_version_id", "rollup_level", "entity_id");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_lookups" ADD CONSTRAINT "scoring_lookups_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_answers" ADD CONSTRAINT "response_answers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_answers" ADD CONSTRAINT "response_answers_survey_response_id_fkey" FOREIGN KEY ("survey_response_id") REFERENCES "survey_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_answers" ADD CONSTRAINT "response_answers_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_answers" ADD CONSTRAINT "response_answers_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_response_answer_id_fkey" FOREIGN KEY ("response_answer_id") REFERENCES "response_answers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_survey_response_id_fkey" FOREIGN KEY ("survey_response_id") REFERENCES "survey_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "response_severity_scores" ADD CONSTRAINT "response_severity_scores_scoring_lookup_id_fkey" FOREIGN KEY ("scoring_lookup_id") REFERENCES "scoring_lookups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_rollups" ADD CONSTRAINT "score_rollups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_rollups" ADD CONSTRAINT "score_rollups_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_rollups" ADD CONSTRAINT "score_rollups_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_rollups" ADD CONSTRAINT "score_rollups_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
