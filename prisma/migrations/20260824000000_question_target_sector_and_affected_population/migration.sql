-- RIO-FR-012/RIO-AI-002 (Round 4, client-confirmed 2026-08-24): a per-question
-- Target Sector tag used as a ranking signal for suggested-question ordering.
ALTER TABLE "questions" ADD COLUMN "target_sector" VARCHAR(100);

-- RIO-FR-005 (Round 4, client-confirmed 2026-08-24): the manually entered
-- Affected Population figure from the need-entry form, split into people and
-- households, as the primary value (GASTAT is a separate, still-blocked
-- reference cross-check pending the client's actual dataset).
ALTER TABLE "needs" ADD COLUMN "affected_people" INTEGER;
ALTER TABLE "needs" ADD COLUMN "affected_households" INTEGER;
