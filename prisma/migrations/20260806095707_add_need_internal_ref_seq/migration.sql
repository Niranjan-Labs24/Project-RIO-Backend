-- RIO-DATA-003: system-generated internal reference for every Need,
-- regardless of entry method. See NeedsService.formatInternalReferenceId
-- for the human-legible "NEED-000123" form derived from this column.
ALTER TABLE "needs" ADD COLUMN "internal_ref_seq" SERIAL NOT NULL;
