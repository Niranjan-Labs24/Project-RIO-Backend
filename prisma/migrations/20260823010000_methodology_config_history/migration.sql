-- RIO-NFR-017 (client-confirmed) — "retain full version history of every
-- methodology configuration change — never overwrite." MethodologyConfig
-- itself stays a single mutable row (its id must stay stable — it's what
-- scoring reads resolve against); this table is the append-only history
-- instead: one immutable snapshot per update()/publish() call.
CREATE TABLE "methodology_config_history" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "config_id" UUID NOT NULL,
  "version" VARCHAR(100) NOT NULL,
  "status" "MethodologyStatus" NOT NULL,
  "change_type" VARCHAR(20) NOT NULL,
  "priority_thresholds" JSONB NOT NULL,
  "priority_factor_weights" JSONB NOT NULL,
  "confidence_flag_settings" JSONB NOT NULL,
  "changed_by" UUID,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "methodology_config_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "methodology_config_history_config_id_idx" ON "methodology_config_history"("config_id");

GRANT SELECT, INSERT, UPDATE ON "methodology_config_history" TO cnap_app;
GRANT SELECT ON "methodology_config_history" TO cnap_supervisor;
