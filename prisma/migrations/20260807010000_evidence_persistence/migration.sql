-- RESTORED 2026-08-07. The original migration.sql for this directory was
-- lost locally (the directory was left empty while the migration itself is
-- recorded as applied in _prisma_migrations, which blocked every `prisma
-- migrate` command with P3015). This file was reconstructed from the live
-- database: the tables/columns/indexes/foreign keys came from
-- `prisma migrate diff --from-migrations`, and the RLS policies and grants —
-- which `migrate diff` never emits — were read back from pg_policies and
-- information_schema.role_table_grants. It reproduces the applied state
-- exactly; the wording of the comments is new.
--
-- Evidence document persistence: the upload -> parse -> AI-summarise ->
-- officer-confirm chain, plus the combined report that draws on those
-- confirmed summaries.
--
--   evidence_documents               the uploaded file + extracted text
--   evidence_document_chunks         parsed text split for AI input
--   evidence_document_summaries      per-document AI summary + officer edit
--   combined_report_summaries        study-level AI summary over the above
--   combined_report_evidence_sources which documents fed a combined report

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

-- PARTIAL unique indexes — the WHERE clause is load-bearing and must not be
-- dropped. "At most one CONFIRMED summary per document/study", while any
-- number of DRAFT rows may coexist (each regeneration writes a new draft).
-- A plain UNIQUE here would forbid regenerating a summary at all. Prisma
-- cannot express partial indexes, which is why these live only in SQL.
CREATE UNIQUE INDEX "evidence_document_one_confirmed"
  ON "evidence_document_summaries"("document_id")
  WHERE ("status" = 'OFFICER_CONFIRMED');
CREATE UNIQUE INDEX "combined_report_one_confirmed"
  ON "combined_report_summaries"("study_id")
  WHERE ("status" = 'OFFICER_CONFIRMED');

-- AddForeignKey
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "evidence_documents" ADD CONSTRAINT "evidence_documents_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: unlinking a Need must not destroy the document.
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

-- Row-level security. Tables that carry org_id isolate on it directly; the
-- child tables (chunks, summaries, sources) have no org_id of their own and
-- instead gate on their parent being visible — since the parent is itself
-- RLS-filtered, an EXISTS against it resolves to "my org's rows only"
-- without duplicating the tenant key down the chain.
ALTER TABLE "evidence_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_documents_org_isolation ON "evidence_documents"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "combined_report_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combined_report_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY combined_report_summaries_org_isolation ON "combined_report_summaries"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "evidence_document_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_document_chunks" FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_document_chunks_org_isolation ON "evidence_document_chunks"
  USING (EXISTS (SELECT 1 FROM "evidence_documents" d WHERE d.id = "evidence_document_chunks".document_id))
  WITH CHECK (EXISTS (SELECT 1 FROM "evidence_documents" d WHERE d.id = "evidence_document_chunks".document_id));

ALTER TABLE "evidence_document_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_document_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_document_summaries_org_isolation ON "evidence_document_summaries"
  USING (EXISTS (SELECT 1 FROM "evidence_documents" d WHERE d.id = "evidence_document_summaries".document_id))
  WITH CHECK (EXISTS (SELECT 1 FROM "evidence_documents" d WHERE d.id = "evidence_document_summaries".document_id));

ALTER TABLE "combined_report_evidence_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "combined_report_evidence_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY combined_report_evidence_sources_org_isolation ON "combined_report_evidence_sources"
  USING (EXISTS (SELECT 1 FROM "combined_report_summaries" s WHERE s.id = "combined_report_evidence_sources".combined_report_summary_id))
  WITH CHECK (EXISTS (SELECT 1 FROM "combined_report_summaries" s WHERE s.id = "combined_report_evidence_sources".combined_report_summary_id));

-- Cross-org read for the supervisor role (runAsSupervisor), same pattern as
-- every other org-scoped table.
CREATE POLICY evidence_documents_supervisor_read ON "evidence_documents" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY evidence_document_chunks_supervisor_read ON "evidence_document_chunks" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY evidence_document_summaries_supervisor_read ON "evidence_document_summaries" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY combined_report_summaries_supervisor_read ON "combined_report_summaries" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY combined_report_evidence_sources_supervisor_read ON "combined_report_evidence_sources" FOR SELECT TO cnap_supervisor USING (true);

-- Runtime grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON "evidence_documents","evidence_document_chunks","evidence_document_summaries","combined_report_summaries","combined_report_evidence_sources" TO cnap_app;
GRANT SELECT ON "evidence_documents","evidence_document_chunks","evidence_document_summaries","combined_report_summaries","combined_report_evidence_sources" TO cnap_supervisor;
