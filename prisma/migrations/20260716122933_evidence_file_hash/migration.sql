/*
  Warnings:

  - Added the required column `file_hash` to the `evidence` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "evidence" ADD COLUMN     "file_hash" VARCHAR(64) NOT NULL;

-- CreateIndex
CREATE INDEX "evidence_study_id_file_hash_idx" ON "evidence"("study_id", "file_hash");
