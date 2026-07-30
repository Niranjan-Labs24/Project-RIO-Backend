-- Additive, purely nullable — existing rows are simply left NULL.
--
-- audit_logs.source_ref: the submitter's own external tracking id for the
-- entity an audit event is about (e.g. a Need's own reference_id — a field
-- form number or partner org's case id), copied in at record() time so an
-- audit-trail lookup can search by that external reference directly instead
-- of digging through the metadata JSON blob. First-class + indexed column
-- rather than another metadata key, since this is meant to be queried on.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "source_ref" VARCHAR(200);

-- CreateIndex
CREATE INDEX "audit_logs_source_ref_idx" ON "audit_logs"("source_ref");
