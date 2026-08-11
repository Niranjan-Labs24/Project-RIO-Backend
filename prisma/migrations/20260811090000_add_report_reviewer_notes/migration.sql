-- RIO-FR-007 clarification (Aug 4): mandatory reviewer notes extend to all
-- four report categories, not just the NCNP Compiled Report. Nullable since
-- existing released/rejected reports predate this requirement and can't
-- retroactively supply notes.
ALTER TABLE "reports" ADD COLUMN "reviewer_notes" TEXT;
