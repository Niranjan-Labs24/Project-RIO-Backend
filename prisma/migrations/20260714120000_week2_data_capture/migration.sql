-- Combines what were 4 separate, not-yet-committed migrations from the same
-- Week 2 (Study/Need/Evidence/AI Classification) pass into one file, in
-- final-state form — e.g. `needs.village`/`studies.villages` are declared as
-- TEXT[] directly on CREATE TABLE, and StudyStatus's enum values are
-- declared in their final form, rather than replaying the intermediate
-- "create as X, then ALTER to Y" steps nobody outside this session ever saw.
-- `organisations.region` predates this migration (added by
-- 20260713030627_init_domain, already committed), so it's still a real
-- ALTER COLUMN below — that one genuinely can't be folded into a CREATE TABLE.

-- cnap_app's USAGE on the public schema was only ever granted by
-- db/init/00-init.sql, which is a docker-entrypoint-initdb.d script — it
-- only runs once, when the Postgres data directory is first initialized.
-- `prisma migrate reset` drops and recreates the `cnap` database itself
-- (not the whole cluster/data directory), which drops this schema-level
-- grant along with it, but leaves the cnap_app role itself in place —
-- so every reset silently breaks cnap_app until this is reapplied by
-- hand. cnap_supervisor already gets its own USAGE grant from a real
-- migration (20260713031212_rls_domain); this closes the same gap for
-- cnap_app so a reset can never lose it again.
GRANT USAGE ON SCHEMA public TO cnap_app;

-- CreateEnum
-- Matches the RIO-FR-001/Add-01/003 flow: draft -> need_captured ->
-- evidence_submitted -> ai_classified -> human_reviewed. Uploading evidence
-- no longer advances status by itself — a researcher must
-- explicitly submit (EvidenceService.submit) before AI Classification is
-- allowed to run; that submit action is what sets evidence_submitted.
CREATE TYPE "StudyStatus" AS ENUM ('draft', 'need_captured', 'evidence_submitted', 'ai_classified', 'human_reviewed');

-- CreateEnum
CREATE TYPE "AiTouchpoint" AS ENUM ('need_classification', 'priority_scoring');

-- CreateTable
CREATE TABLE "studies" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    -- Selected from (or added alongside) the org's own configured villages
    -- list — same array-of-strings shape as Organisation.villages, not a
    -- master-data table.
    "villages" TEXT[] NOT NULL DEFAULT '{}',
    "status" "StudyStatus" NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- RIO-FR-001: a Study contains exactly one Need — enforced via the unique
-- studyId index below (1:1 at the DB level, not just app-level convention).
CREATE TABLE "needs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "study_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    -- A Need can name more than one village — same array-of-strings shape
    -- as Organisation.villages/region, not a single comma-separated string.
    "village" TEXT[] NOT NULL DEFAULT '{}',
    "source" VARCHAR(200) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "needs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- RIO-FR-Add-01: multiple files per Study, uploaded after the Need exists.
-- storageKey is a local disk path for Phase 1 — kept as a plain string so
-- swapping to an object-storage key later needs no schema change.
CREATE TABLE "evidence" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "study_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(100) NOT NULL,
    -- Bytes — needed for the 10MB/file, 10-files/study caps and the
    -- Evidence table's Size column.
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "storage_key" VARCHAR(500) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- One generic table for every AI touchpoint — AI suggestion and human
-- override are separate columns on the same row (auditable, explainable),
-- not a separate table per touchpoint.
CREATE TABLE "ai_decisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "touchpoint" "AiTouchpoint" NOT NULL,
    "subject_type" VARCHAR(100) NOT NULL,
    "subject_id" UUID NOT NULL,
    "model_name" VARCHAR(150) NOT NULL,
    "model_version" VARCHAR(100) NOT NULL,
    "suggestion" JSONB NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "human_decision" JSONB,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "studies_org_id_idx" ON "studies"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "needs_study_id_key" ON "needs"("study_id");

-- CreateIndex
CREATE INDEX "needs_org_id_idx" ON "needs"("org_id");

-- CreateIndex
CREATE INDEX "evidence_study_id_idx" ON "evidence"("study_id");

-- CreateIndex
CREATE INDEX "evidence_org_id_idx" ON "evidence"("org_id");

-- CreateIndex
CREATE INDEX "ai_decisions_org_id_idx" ON "ai_decisions"("org_id");

-- CreateIndex
CREATE INDEX "ai_decisions_subject_type_subject_id_idx" ON "ai_decisions"("subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "studies" ADD CONSTRAINT "studies_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "needs" ADD CONSTRAINT "needs_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "needs" ADD CONSTRAINT "needs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decisions" ADD CONSTRAINT "ai_decisions_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) — same fail-closed NULLIF policy as
-- every other org_id-keyed table (see 20260713031212_rls_domain).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['studies','needs','evidence','ai_decisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid);',
      t || '_org_isolation', t);
  END LOOP;
END $$;

-- Runtime grants for cnap_app (NOBYPASSRLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON "studies","needs","evidence" TO cnap_app;
GRANT SELECT, INSERT, UPDATE ON "ai_decisions" TO cnap_app;

-- Cross-org read-only supervisor policies (Center Supervisor's read access —
-- same pattern as organisations_supervisor_read etc.).
CREATE POLICY studies_supervisor_read ON "studies" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY needs_supervisor_read ON "needs" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY evidence_supervisor_read ON "evidence" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY ai_decisions_supervisor_read ON "ai_decisions" FOR SELECT TO cnap_supervisor USING (true);

-- Organisation.region: predates this migration (added nullable by
-- 20260713030627_init_domain, already committed) — this table isn't new
-- here, so this is a genuine ALTER, not something foldable into a CREATE
-- TABLE above. Same array-of-strings shape as `villages`/`needs.village`:
-- an org can span more than one region, not a single comma-separated string.
-- Postgres' ALTER COLUMN ... TYPE ... USING clause doesn't allow a
-- correlated subquery, so comma spacing is normalized with regexp_replace
-- first, then split with a plain string_to_array.
ALTER TABLE "organisations" ALTER COLUMN "region" TYPE TEXT[] USING
  CASE
    WHEN region IS NULL OR btrim(region) = '' THEN ARRAY[]::TEXT[]
    ELSE string_to_array(regexp_replace(btrim(region), '\s*,\s*', ',', 'g'), ',')
  END;
ALTER TABLE "organisations" ALTER COLUMN "region" SET DEFAULT '{}';
ALTER TABLE "organisations" ALTER COLUMN "region" SET NOT NULL;
