-- RIO-DATA-003: system-generated internal reference for every Need,
-- regardless of entry method. See NeedsService.formatInternalReferenceId
-- for the human-legible "NEED-000123" form derived from this column.
ALTER TABLE "needs" ADD COLUMN "internal_ref_seq" SERIAL NOT NULL;

-- A SERIAL column creates its own sequence, which is NOT covered by any
-- existing table-level GRANT on "needs" — cnap_app (the runtime role) needs
-- explicit USAGE/SELECT on the sequence itself or every Need insert fails
-- with "permission denied for sequence needs_internal_ref_seq_seq".
GRANT USAGE, SELECT ON SEQUENCE "needs_internal_ref_seq_seq" TO cnap_app;
