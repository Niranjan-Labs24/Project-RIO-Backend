-- RIO-FR-005 (Q12) — Gap Type: five fixed values (acute/chronic/structural/
-- seasonal/equity), analyst-entered, never auto-calculated. Optional.
ALTER TABLE "needs" ADD COLUMN "gap_type" VARCHAR(20);

-- RIO-FR-005 — the decision's own effective date, distinct from the
-- system-generated created_at timestamp. need_decisions had zero rows at
-- the time this was added, so a straight NOT NULL is safe with no backfill.
ALTER TABLE "need_decisions" ADD COLUMN "decision_date" DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE "need_decisions" ALTER COLUMN "decision_date" DROP DEFAULT;
