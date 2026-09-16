-- RIO-FR-005 — Intervention/Follow-up decision logging against a Need.
-- Client-confirmed (Q10/Q11/Q34): configurable Decision Types (seeded below
-- with the three client-named starting values), free-text Responsible
-- Party, fixed Open/In Progress/Completed/Cancelled status with full
-- history, and a hard block on logging against a Need with no *approved*
-- priority score yet.

CREATE TABLE "decision_type_options" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "name" VARCHAR(100) NOT NULL,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "decision_type_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "decision_type_options_name_key" ON "decision_type_options"("name");

GRANT SELECT, INSERT, UPDATE ON "decision_type_options" TO cnap_app;
GRANT SELECT ON "decision_type_options" TO cnap_supervisor;

-- Client-confirmed starting values (Q10) — extensible later via the same
-- admin screen this table backs (see StudyTypeOption's sibling pattern).
INSERT INTO "decision_type_options" ("id", "name", "display_order", "updated_at") VALUES
  (uuidv7(), 'Intervention', 0, now()),
  (uuidv7(), 'Escalation', 1, now()),
  (uuidv7(), 'Follow-up', 2, now());

CREATE TABLE "need_decisions" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "need_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "decision_type" VARCHAR(100) NOT NULL,
  "responsible_party" VARCHAR(300) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "notes" TEXT,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "need_decisions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "need_decisions_org_id_idx" ON "need_decisions"("org_id");
CREATE INDEX "need_decisions_need_id_idx" ON "need_decisions"("need_id");
ALTER TABLE "need_decisions" ADD CONSTRAINT "need_decisions_need_id_fkey"
  FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "need_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_decisions" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_decisions_org_isolation ON "need_decisions"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "need_decisions" TO cnap_app;
GRANT SELECT ON "need_decisions" TO cnap_supervisor;

CREATE POLICY need_decisions_supervisor_read ON "need_decisions" FOR SELECT TO cnap_supervisor USING (true);

CREATE TABLE "need_decision_status_events" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "decision_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "from_status" VARCHAR(20),
  "to_status" VARCHAR(20) NOT NULL,
  "changed_by" UUID NOT NULL,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "note" TEXT,

  CONSTRAINT "need_decision_status_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "need_decision_status_events_org_id_idx" ON "need_decision_status_events"("org_id");
CREATE INDEX "need_decision_status_events_decision_id_idx" ON "need_decision_status_events"("decision_id");
ALTER TABLE "need_decision_status_events" ADD CONSTRAINT "need_decision_status_events_decision_id_fkey"
  FOREIGN KEY ("decision_id") REFERENCES "need_decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "need_decision_status_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_decision_status_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_decision_status_events_org_isolation ON "need_decision_status_events"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON "need_decision_status_events" TO cnap_app;
GRANT SELECT ON "need_decision_status_events" TO cnap_supervisor;

CREATE POLICY need_decision_status_events_supervisor_read ON "need_decision_status_events" FOR SELECT TO cnap_supervisor USING (true);
