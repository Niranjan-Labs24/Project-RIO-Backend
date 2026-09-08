-- RIO-FR-009: analytical status on Need + new Initiative entity/linkage.

CREATE TYPE "AnalyticalStatus" AS ENUM ('observed', 'under_analysis', 'documented_in_study', 'linked_to_initiative', 'open_gap');

ALTER TABLE "needs" ADD COLUMN IF NOT EXISTS "analytical_status" "AnalyticalStatus" NOT NULL DEFAULT 'observed';

CREATE TABLE IF NOT EXISTS "need_analytical_status_events" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "need_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "from_status" "AnalyticalStatus",
  "to_status" "AnalyticalStatus" NOT NULL,
  "changed_by" UUID,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note" TEXT,
  CONSTRAINT "need_analytical_status_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "need_analytical_status_events_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "need_analytical_status_events_org_id_idx" ON "need_analytical_status_events"("org_id");
CREATE INDEX IF NOT EXISTS "need_analytical_status_events_need_id_idx" ON "need_analytical_status_events"("need_id");

CREATE TABLE IF NOT EXISTS "initiatives" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "org_id" UUID NOT NULL,
  "name" VARCHAR(300) NOT NULL,
  "domain" VARCHAR(120),
  "geography" TEXT,
  "start_date" DATE,
  "expected_end_date" DATE,
  "status" VARCHAR(30) NOT NULL DEFAULT 'active',
  "funding_source" VARCHAR(200),
  "description" TEXT,
  "budget" DECIMAL(14,2),
  "open_to_other_entities" BOOLEAN NOT NULL DEFAULT false,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "initiatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "initiatives_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "initiatives_org_id_idx" ON "initiatives"("org_id");

CREATE TABLE IF NOT EXISTS "need_initiatives" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "need_id" UUID NOT NULL,
  "initiative_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "linked_by" UUID NOT NULL,
  "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "need_initiatives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "need_initiatives_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE,
  CONSTRAINT "need_initiatives_initiative_id_fkey" FOREIGN KEY ("initiative_id") REFERENCES "initiatives"("id") ON DELETE CASCADE,
  CONSTRAINT "need_initiatives_need_id_initiative_id_key" UNIQUE ("need_id", "initiative_id")
);
CREATE INDEX IF NOT EXISTS "need_initiatives_need_id_idx" ON "need_initiatives"("need_id");
CREATE INDEX IF NOT EXISTS "need_initiatives_initiative_id_idx" ON "need_initiatives"("initiative_id");

ALTER TYPE "PermissionModule" ADD VALUE IF NOT EXISTS 'initiatives';
-- RIO-FR-009: RLS for the three new tables, matching the existing
-- need_decisions / need_decision_status_events pattern exactly, plus a
-- widened read policy on `initiatives` for the client's Q15
-- open-to-other-entities visibility model.

ALTER TABLE "initiatives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "initiatives" FORCE ROW LEVEL SECURITY;

-- Read: own org's initiatives, OR any org's initiative explicitly marked
-- open (client Q15). Write (insert/update/delete): own org only, regardless
-- of the open flag — a visible-to-others initiative is still not
-- editable by anyone but its owner.
CREATE POLICY initiatives_read ON "initiatives"
  FOR SELECT
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR open_to_other_entities = true
  );
CREATE POLICY initiatives_write ON "initiatives"
  FOR INSERT
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY initiatives_update ON "initiatives"
  FOR UPDATE
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY initiatives_delete ON "initiatives"
  FOR DELETE
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "initiatives" TO cnap_app;
GRANT SELECT ON "initiatives" TO cnap_supervisor;
CREATE POLICY initiatives_supervisor_read ON "initiatives" FOR SELECT TO cnap_supervisor USING (true);

ALTER TABLE "need_initiatives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_initiatives" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_initiatives_org_isolation ON "need_initiatives"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON "need_initiatives" TO cnap_app;
GRANT SELECT ON "need_initiatives" TO cnap_supervisor;
CREATE POLICY need_initiatives_supervisor_read ON "need_initiatives" FOR SELECT TO cnap_supervisor USING (true);

ALTER TABLE "need_analytical_status_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_analytical_status_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_analytical_status_events_org_isolation ON "need_analytical_status_events"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON "need_analytical_status_events" TO cnap_app;
GRANT SELECT ON "need_analytical_status_events" TO cnap_supervisor;
CREATE POLICY need_analytical_status_events_supervisor_read ON "need_analytical_status_events" FOR SELECT TO cnap_supervisor USING (true);
