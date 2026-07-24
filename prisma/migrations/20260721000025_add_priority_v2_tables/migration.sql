-- CreateTable
CREATE TABLE "domain_priority_configs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "methodology_version_id" UUID NOT NULL,
    "domain_key" VARCHAR(100) NOT NULL,
    "domain_name_snapshot" VARCHAR(200) NOT NULL,
    "weight" DECIMAL(6,5) NOT NULL,
    "is_critical_domain" BOOLEAN NOT NULL DEFAULT false,
    "critical_performance_threshold" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domain_priority_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "village_priority_assessments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "village_id" VARCHAR(150) NOT NULL,
    "methodology_version_id" UUID NOT NULL,
    "priority_score" DECIMAL(8,4) NOT NULL,
    "priority_status" VARCHAR(20) NOT NULL,
    "override_applied" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" VARCHAR(500),
    "domain_components" JSONB NOT NULL,
    "calculated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculation_version" VARCHAR(64) NOT NULL,

    CONSTRAINT "village_priority_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_priority_configs_methodology_version_id_idx" ON "domain_priority_configs"("methodology_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_priority_configs_methodology_version_id_domain_key_key" ON "domain_priority_configs"("methodology_version_id", "domain_key");

-- CreateIndex
CREATE INDEX "village_priority_assessments_org_id_idx" ON "village_priority_assessments"("org_id");

-- CreateIndex
CREATE INDEX "village_priority_assessments_study_id_idx" ON "village_priority_assessments"("study_id");

-- CreateIndex
CREATE INDEX "village_priority_assessments_survey_id_idx" ON "village_priority_assessments"("survey_id");

-- CreateIndex
CREATE UNIQUE INDEX "village_priority_assessments_study_id_survey_id_village_id__key" ON "village_priority_assessments"("study_id", "survey_id", "village_id", "methodology_version_id");

-- AddForeignKey
ALTER TABLE "domain_priority_configs" ADD CONSTRAINT "domain_priority_configs_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_priority_assessments" ADD CONSTRAINT "village_priority_assessments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_priority_assessments" ADD CONSTRAINT "village_priority_assessments_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_priority_assessments" ADD CONSTRAINT "village_priority_assessments_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_priority_assessments" ADD CONSTRAINT "village_priority_assessments_methodology_version_id_fkey" FOREIGN KEY ("methodology_version_id") REFERENCES "methodology_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
