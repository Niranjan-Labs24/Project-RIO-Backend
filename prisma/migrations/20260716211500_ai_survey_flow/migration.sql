-- AlterTable
ALTER TABLE "studies" ADD COLUMN     "domain" VARCHAR(120),
ADD COLUMN     "problem_statement" TEXT,
ADD COLUMN     "sub_domain" VARCHAR(120);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "question_id" VARCHAR(64) NOT NULL,
    "domain" VARCHAR(120) NOT NULL,
    "sub_domain" VARCHAR(120) NOT NULL,
    "indicator" VARCHAR(200),
    "kpi" VARCHAR(200),
    "question_text" TEXT NOT NULL,
    "answer_type" VARCHAR(64) NOT NULL,
    "answer_options" JSONB,
    "required_optional" VARCHAR(64) NOT NULL,
    "used_in_mvp" BOOLEAN NOT NULL DEFAULT true,
    "report_mapping" TEXT,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "input_hash" VARCHAR(64),
    "suggested_domain" VARCHAR(120),
    "suggested_sub_domain" VARCHAR(120),
    "suggested_question_ids" JSONB,
    "confidence" DECIMAL(5,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "model_name" VARCHAR(150) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "raw_response" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_decisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "ai_suggestion_id" UUID,
    "decision" VARCHAR(64) NOT NULL,
    "final_domain" VARCHAR(120),
    "final_sub_domain" VARCHAR(120),
    "final_question_ids" JSONB,
    "reason" TEXT,
    "decided_by" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "surveys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "status" VARCHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "survey_questions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "survey_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "questions_question_id_key" ON "questions"("question_id");

-- CreateIndex
CREATE INDEX "questions_domain_sub_domain_idx" ON "questions"("domain", "sub_domain");

-- CreateIndex
CREATE INDEX "ai_suggestions_org_id_idx" ON "ai_suggestions"("org_id");

-- CreateIndex
CREATE INDEX "ai_suggestions_study_id_idx" ON "ai_suggestions"("study_id");

-- CreateIndex
CREATE INDEX "human_decisions_org_id_idx" ON "human_decisions"("org_id");

-- CreateIndex
CREATE INDEX "human_decisions_study_id_idx" ON "human_decisions"("study_id");

-- CreateIndex
CREATE INDEX "surveys_org_id_idx" ON "surveys"("org_id");

-- CreateIndex
CREATE INDEX "surveys_study_id_idx" ON "surveys"("study_id");

-- CreateIndex
CREATE INDEX "survey_questions_survey_id_idx" ON "survey_questions"("survey_id");

-- CreateIndex
CREATE INDEX "survey_questions_question_id_idx" ON "survey_questions"("question_id");

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_ai_suggestion_id_fkey" FOREIGN KEY ("ai_suggestion_id") REFERENCES "ai_suggestions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable RLS
ALTER TABLE "ai_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_suggestions" FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_suggestions_org_isolation ON "ai_suggestions" USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "human_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "human_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY human_decisions_org_isolation ON "human_decisions" USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "surveys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "surveys" FORCE ROW LEVEL SECURITY;
CREATE POLICY surveys_org_isolation ON "surveys" USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid) WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "survey_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "survey_questions" FORCE ROW LEVEL SECURITY;
CREATE POLICY survey_questions_org_isolation ON "survey_questions" 
  USING (EXISTS (SELECT 1 FROM "surveys" s WHERE s.id = survey_id))
  WITH CHECK (EXISTS (SELECT 1 FROM "surveys" s WHERE s.id = survey_id));

-- App grants
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_suggestions", "human_decisions", "surveys", "survey_questions" TO cnap_app;
GRANT SELECT ON "questions" TO cnap_app;

-- Supervisor read policies
CREATE POLICY questions_supervisor_read ON "questions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY ai_suggestions_supervisor_read ON "ai_suggestions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY human_decisions_supervisor_read ON "human_decisions" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY surveys_supervisor_read ON "surveys" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY survey_questions_supervisor_read ON "survey_questions" FOR SELECT TO cnap_supervisor USING (true);

