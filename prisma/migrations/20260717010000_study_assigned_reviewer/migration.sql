-- Study.assignedReviewerId: the NGO Research Officer who owns a Study's AI
-- Classification human review, set at Study creation. Nullable (existing
-- Studies have no assignment and keep displaying "Unassigned" until edited —
-- no backfill needed, NULL is exactly the correct value for them). On
-- DELETE SET NULL: removing the assigned user's account must not block or
-- cascade-delete the Study itself.
ALTER TABLE "studies" ADD COLUMN "assigned_reviewer_id" UUID;
CREATE INDEX "studies_assigned_reviewer_id_idx" ON "studies"("assigned_reviewer_id");
ALTER TABLE "studies" ADD CONSTRAINT "studies_assigned_reviewer_id_fkey"
  FOREIGN KEY ("assigned_reviewer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
