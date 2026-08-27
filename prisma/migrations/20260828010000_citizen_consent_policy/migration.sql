-- Citizen consent becomes a versioned, admin-managed policy (2026-08-27),
-- the same treatment the signup Terms of Use / Data Sharing Policy just
-- received and for the same reason: the notice a citizen accepts before a
-- public survey collects anything was hard-coded — its wording in the
-- frontend's messages/en.json and messages/ar.json, its version in a
-- CONSENT_COPY_VERSION constant — so changing it meant a code release, no
-- System Reviewer ever approved it, and nothing recorded which version any
-- respondent had actually agreed to.
--
-- Three parts:
--   1. `citizen_consent` joins the ConsentPolicyKind enum, so it moves
--      through the identical draft -> pending_approval -> approved ->
--      published workflow, with the same RBAC gate and audit trail.
--   2. The wording currently shown to citizens is INSERTed as v1.0 — this is
--      not new hard-coded content, it is the existing content being moved
--      into the store that now owns it. The frontend copy is deleted in the
--      same change, so it lives in exactly one place afterwards.
--   3. survey_responses gains the three columns that pin each submission to
--      the version its respondent read.

-- 1. New policy kind. Alone in its own statement and never referenced later
-- in this file: Postgres refuses to use an enum value added in the same
-- transaction that added it, so the INSERT below casts the literal instead.
ALTER TYPE "ConsentPolicyKind" ADD VALUE IF NOT EXISTS 'citizen_consent';

-- 3. Per-response consent record (RIO-NFR-002). Nullable: responses collected
-- before this migration have no version to name, and back-filling them with a
-- version their respondents never saw would be a fabricated audit record.
-- Every submission after this is required to carry one.
ALTER TABLE "survey_responses"
  ADD COLUMN "consent_policy_version" VARCHAR(64),
  ADD COLUMN "consent_policy_locale" VARCHAR(8),
  ADD COLUMN "consented_at" TIMESTAMPTZ(6);
