-- PR 27: evidence document persistence (uploaded evidence, per-document AI
-- summaries, and the combined evidence+score report summary). These five
-- tables were already declared in schema.prisma but had no migration —
-- caught by test/pr27-migration.integration.spec.ts running against a truly
-- fresh database.

-- CreateTable
CREATE TABLE "evidence_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(100) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "document_type" VARCHAR(100) NOT NULL,
    "source_reference_id" VARCHAR(100) NOT NULL,
    "collected_date" TIMESTAMPTZ(6) NOT NULL,
    "description" VARCHAR(1000),
    "linked_need_id" UUID,
    "linked_domain_id" VARCHAR(120),
    "linked_kpi_id" VARCHAR(200),
    "parsing_status" VARCHAR(50) NOT NULL DEFAULT 'UPLOADED',
    "extracted_text" TEXT,
    "parsed_at" TIMESTAMPTZ(6),
    "parse_error" TEXT,
    "is_included_in_combined_report" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_document_chunks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "document_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "page_number" INTEGER,
    "section_reference" VARCHAR(200),
    "chunk_text" TEXT NOT NULL,
    "chunk_summary" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_document_summaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "document_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    "prompt_version" VARCHAR(100) NOT NULL DEFAULT 'evidence-doc-summary-v1',
    "model_name" VARCHAR(100) NOT NULL DEFAULT 'gemini-2.5-flash',
    "model_version" VARCHAR(50) NOT NULL DEFAULT 'v1',
    "input_text_hash" VARCHAR(64) NOT NULL,
    "ai_output_json" JSONB NOT NULL,
    "officer_edited_output_json" JSONB,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "evidence_document_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combined_report_summaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "study_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "report_data_snapshot_id" VARCHAR(100) NOT NULL,
    "score_summary_id" UUID NOT NULL,
    "status" VARCHAR(50) NOT NULL DEFAULT 'DRAFT',
    "prompt_version" VARCHAR(100) NOT NULL DEFAULT 'combined-report-summary-v1',
    "model_name" VARCHAR(100) NOT NULL DEFAULT 'gemini-2.5-flash',
    "model_version" VARCHAR(50) NOT NULL DEFAULT 'v1',
    "input_hash" VARCHAR(64) NOT NULL,
    "ai_output_json" JSONB NOT NULL,
    "officer_edited_output_json" JSONB,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "combined_report_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combined_report_evidence_sources" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "combined_report_summary_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_summary_id" UUID NOT NULL,
    "included_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "included_by" UUID NOT NULL,

    CONSTRAINT "combined_report_evidence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_documents_org_id_idx" ON "evidence_documents"("org_id");
CREATE INDEX "evidence_documents_study_id_idx" ON "evidence_documents"("study_id");
CREATE INDEX "evidence_documents_linked_need_id_idx" ON "evidence_documents"("linked_need_id");
CREATE INDEX "evidence_document_chunks_document_id_idx" ON "evidence_document_chunks"("document_id");
CREATE INDEX "evidence_document_summaries_document_id_idx" ON "evidence_document_summaries"("document_id");
CREATE INDEX "evidence_document_summaries_study_id_idx" ON "evidence_document_summaries"("study_id");
CREATE INDEX "combined_report_summaries_study_id_idx" ON "combined_report_summaries"("study_id");
CREATE INDEX "combined_report_summaries_org_id_idx" ON "combined_report_summaries"("org_id");
CREATE INDEX "combined_report_summaries_score_summary_id_idx" ON "combined_report_summaries"("score_summary_id");
CREATE INDEX "combined_report_evidence_sources_combined_report_summary_id_idx" ON "combined_report_evidence_sources"("combined_report_summary_id");
CREATE INDEX "combined_report_evidence_sources_document_id_idx" ON "combined_report_evidence_sources"("document_id");
CREATE INDEX "combined_report_evidence_sources_document_summary_id_idx" ON "combined_report_evidence_sources"("document_summary_id");

-- Only one OFFICER_CONFIRMED summary may exist per scope at a time — a
-- second confirm attempt must be rejected outright (23505), not silently
-- create a competing "confirmed" record.
CREATE UNIQUE INDEX "evidence_document_one_confirmed" ON "evidence_document_summaries"("document_id") WHERE "status" = 'OFFICER_CONFIRMED';
CREATE UNIQUE INDEX "combined_report_one_confirmed" ON "combined_report_summaries"("study_id") WHERE "status" = 'OFFICER_CONFIRMED';

-- AddForeignKey
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_linked_need_id_fkey" FOREIGN KEY ("linked_need_id") REFERENCES "needs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "evidence_document_chunks" ADD CONSTRAINT "evidence_document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "evidence_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_document_summaries" ADD CONSTRAINT "evidence_document_summaries_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "evidence_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_document_summaries" ADD CONSTRAINT "evidence_document_summaries_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_summaries" ADD CONSTRAINT "combined_report_summaries_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_summaries" ADD CONSTRAINT "combined_report_summaries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_summaries" ADD CONSTRAINT "combined_report_summaries_score_summary_id_fkey" FOREIGN KEY ("score_summary_id") REFERENCES "ai_priority_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_evidence_sources" ADD CONSTRAINT "combined_report_evidence_sources_combined_report_summary_i_fkey" FOREIGN KEY ("combined_report_summary_id") REFERENCES "combined_report_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_evidence_sources" ADD CONSTRAINT "combined_report_evidence_sources_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "evidence_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "combined_report_evidence_sources" ADD CONSTRAINT "combined_report_evidence_sources_document_summary_id_fkey" FOREIGN KEY ("document_summary_id") REFERENCES "evidence_document_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: same tenant-isolation pattern as every other org-scoped
-- table (see 20260714120000_week2_data_capture). evidence_documents and
-- combined_report_summaries carry org_id directly; the three child tables
-- don't (by design — no denormalized org_id), so their policy checks org
-- ownership via their parent instead.
ALTER TABLE "evidence_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evidence_documents_org_isolation" ON "evidence_documents"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "evidence_document_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_document_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evidence_document_chunks_org_isolation" ON "evidence_document_chunks"
  USING (document_id IN (SELECT id FROM "evidence_documents" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (document_id IN (SELECT id FROM "evidence_documents" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE "evidence_document_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_document_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evidence_document_summaries_org_isolation" ON "evidence_document_summaries"
  USING (study_id IN (SELECT id FROM "studies" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (study_id IN (SELECT id FROM "studies" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE "combined_report_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combined_report_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "combined_report_summaries_org_isolation" ON "combined_report_summaries"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "combined_report_evidence_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combined_report_evidence_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "combined_report_evidence_sources_org_isolation" ON "combined_report_evidence_sources"
  USING (combined_report_summary_id IN (SELECT id FROM "combined_report_summaries" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (combined_report_summary_id IN (SELECT id FROM "combined_report_summaries" WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid));

-- Runtime grants for cnap_app (NOBYPASSRLS) — table-level grants are never
-- automatic for a newly created table (see the cnap_app sequence-grant gap
-- fixed in 20260806095707_add_need_internal_ref_seq for the same lesson).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "evidence_documents", "evidence_document_chunks", "evidence_document_summaries",
  "combined_report_summaries", "combined_report_evidence_sources"
  TO cnap_app;

-- Cross-org read-only supervisor policies — same pattern as every other
-- table's own "_supervisor_read" policy (see 20260714120000_week2_data_capture).
CREATE POLICY "evidence_documents_supervisor_read" ON "evidence_documents" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY "evidence_document_chunks_supervisor_read" ON "evidence_document_chunks" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY "evidence_document_summaries_supervisor_read" ON "evidence_document_summaries" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY "combined_report_summaries_supervisor_read" ON "combined_report_summaries" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY "combined_report_evidence_sources_supervisor_read" ON "combined_report_evidence_sources" FOR SELECT TO cnap_supervisor USING (true);
