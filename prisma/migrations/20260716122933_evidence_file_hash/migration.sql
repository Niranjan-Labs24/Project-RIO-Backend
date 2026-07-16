-- Adds Evidence.fileHash (sha256 hex of the uploaded bytes) + the lookup
-- index duplicate detection queries on.
--
-- Nullable, and deliberately not `NOT NULL` with a backfill the way
-- needs.title was. The difference matters: a Need's title could be copied
-- from its parent Study in pure SQL, but a file's sha256 lives in the file's
-- bytes on disk and Postgres cannot read storageKey. Pre-existing rows
-- therefore keep a null hash and are skipped by duplicate detection (see
-- EvidenceService.upload, which filters nulls out of the comparison set).
-- Every row created from here on has a real hash.
--
-- Tightening this to NOT NULL later needs an application-level backfill that
-- re-reads every storageKey off disk and tolerates files that have gone
-- missing.

-- AlterTable
ALTER TABLE "evidence" ADD COLUMN "file_hash" VARCHAR(64);

-- CreateIndex
CREATE INDEX "evidence_study_id_file_hash_idx" ON "evidence"("study_id", "file_hash");
