-- RIO-FR-005 — Heat Map KPI-level side panel, per the product team's
-- request (2026-09-21): each KPI row needs an Equity Flag. `PriorityService.score()`
-- already computes this (`equityFlagged = equitySpread >= equitySpreadThreshold`)
-- to pick the tier via mapPriorityLevel(), but only ever used it transiently —
-- never persisted it. Persisting it here so the KPI panel (and anything else
-- that wants "was this Need's tier equity-elevated") can read it back exactly
-- as computed at scoring time, instead of recomputing it later against
-- whatever the equity-spread threshold happens to be at read time.
ALTER TABLE "priority_scores" ADD COLUMN "equity_flagged" BOOLEAN NOT NULL DEFAULT false;
