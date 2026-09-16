-- Client-confirmed (2026-08-27), superseding the hardcoded/seed-only consent
-- text of V1: "dynamically managed and versioned consent policies in V2, not
-- hard-coded", with System Admin drafting a version and System Reviewer
-- giving final sign-off before it is published and shown at signup.
--
-- The table already versioned by (kind, version) and already snapshotted the
-- accepted wording into consent_acceptances, so this migration adds the two
-- things that were missing: the approval workflow the new version has to
-- clear, and the authorship/review provenance an auditor needs. No history
-- side-table (cf. methodology_config_history) is required — a consent policy
-- version has always been its own row, so the version history IS the table.

CREATE TYPE "ConsentPolicyStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'published');

ALTER TABLE "consent_policies"
  ADD COLUMN "status" "ConsentPolicyStatus" NOT NULL DEFAULT 'draft',
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  ADD COLUMN "created_by" UUID,
  ADD COLUMN "updated_by" UUID,
  ADD COLUMN "reviewed_by" UUID,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "review_notes" TEXT,
  ADD COLUMN "published_by" UUID,
  ADD COLUMN "published_at" TIMESTAMPTZ(6);

-- Every pre-existing row was live (or previously live) policy text seeded by
-- migration — none of it is a draft. Defaulting them to 'draft' would have
-- made the currently-active policy read as unpublished the moment this
-- deploys, and the admin screen would then offer to "publish" text that has
-- been shown at signup for months. `published_at` falls back to `created_at`
-- so the provenance column is never emptier than what we actually know.
UPDATE "consent_policies"
SET "status" = 'published',
    "published_at" = "created_at",
    "updated_at" = "created_at";

-- The signup lookup is `kind + active`; the admin list and the reviewer's
-- "what is awaiting me" lookup are `kind + status`.
CREATE INDEX "consent_policies_kind_status_idx" ON "consent_policies"("kind", "status");

-- consent_policies has been SELECT-only for cnap_app since the RLS migration
-- (it was reference data nobody could edit through the app). Drafting,
-- reviewing and publishing a version all write to it, so the app role needs
-- INSERT/UPDATE now. Still no DELETE: version history is retained in full
-- (client requirement 4), so a version is superseded, never removed.
GRANT INSERT, UPDATE ON "consent_policies" TO cnap_app;
