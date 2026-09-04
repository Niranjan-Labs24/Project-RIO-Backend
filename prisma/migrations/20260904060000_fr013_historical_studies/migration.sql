-- RIO-FR-013 (client Q25, confirmed by Ganesh 2026-09-04): historical/
-- pre-platform study uploads into the Archive.

CREATE TABLE "historical_studies" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "region" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "target_sector" VARCHAR(100),
    "study_date" DATE NOT NULL,
    "author" VARCHAR(300) NOT NULL,
    "methodology_version_label" VARCHAR(300) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_type" VARCHAR(100) NOT NULL,
    "file_size" INTEGER NOT NULL DEFAULT 0,
    "storage_key" VARCHAR(500) NOT NULL,
    "file_hash" VARCHAR(64),
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "historical_studies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historical_studies_org_id_idx" ON "historical_studies"("org_id");

ALTER TABLE "historical_studies" ADD CONSTRAINT "historical_studies_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: own org can insert/read its own uploads; no update/delete at all —
-- historical study entries are permanent once uploaded, same as every
-- other Archive entry (client Q27). Cross-entity roles (System Admin,
-- Center Supervisor) read everything via cnap_supervisor, same pattern as
-- every other Archive-adjacent table.
ALTER TABLE "historical_studies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "historical_studies" FORCE ROW LEVEL SECURITY;

CREATE POLICY historical_studies_read ON "historical_studies"
  FOR SELECT
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY historical_studies_write ON "historical_studies"
  FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON "historical_studies" TO cnap_app;
GRANT SELECT ON "historical_studies" TO cnap_supervisor;
CREATE POLICY historical_studies_supervisor_read ON "historical_studies" FOR SELECT TO cnap_supervisor USING (true);
