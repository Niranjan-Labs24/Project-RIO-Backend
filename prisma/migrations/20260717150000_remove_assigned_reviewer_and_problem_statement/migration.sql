-- Product decision (per today's discussion): there is no concept of
-- assigning a Study to a specific reviewer — any Reviewer/Approver in the
-- org can act on any pending AI Classification. And Study never gets its
-- own "problem statement" field — the Need Statement (captured in the
-- existing Need workflow) is the one source AI Classification reasons over.
-- domain/sub_domain are KEPT — they're still set once a human approves an
-- AI Classification decision (see AiDecisionsService.review).
ALTER TABLE "studies" DROP CONSTRAINT IF EXISTS "studies_assigned_reviewer_id_fkey";
DROP INDEX IF EXISTS "studies_assigned_reviewer_id_idx";
ALTER TABLE "studies" DROP COLUMN IF EXISTS "assigned_reviewer_id";
ALTER TABLE "studies" DROP COLUMN IF EXISTS "problem_statement";
