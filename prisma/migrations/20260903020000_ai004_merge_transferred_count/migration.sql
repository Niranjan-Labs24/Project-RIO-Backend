-- RIO-AI-004 — keep the size of a merge after it is undone.
--
-- The merge history counted transferred items from need_merge_transfers, and
-- undo deletes those rows (they are the instruction for putting things back,
-- and leaving them would make a later re-merge ambiguous). The consequence
-- showed up the moment the history endpoint was called against real data: an
-- undone merge reported "0 items moved", which is not what happened and reads
-- as though the merge did nothing.
--
-- The audit log still had the true figure, but the history screen is where a
-- reviewer actually looks. Storing the count on the merge itself keeps it
-- after the ledger is cleared.
--
-- Defaulted to 0 and backfilled from the ledger for merges that still have one.
ALTER TABLE "need_merges" ADD COLUMN "transferred_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "need_merges" m
SET "transferred_count" = (
  SELECT count(*) FROM "need_merge_transfers" t WHERE t."merge_id" = m."id"
)
WHERE EXISTS (SELECT 1 FROM "need_merge_transfers" t WHERE t."merge_id" = m."id");
