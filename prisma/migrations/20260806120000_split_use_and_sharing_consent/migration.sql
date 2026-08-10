-- RIO-DATA-001 — split the single combined consent into two separate,
-- separately-versioned consents: the platform use policy and a distinct
-- data-sharing consent.
--
-- Before this migration `consent_policies` held one global policy and
-- `consent_acceptances` recorded acceptance of it with no discriminator, so
-- there was no way to express "accepted the use policy but not the sharing
-- consent", nor to version the two independently. Every pre-existing row is
-- an acceptance of the use policy by definition, which is why `use_policy`
-- is the column default and the backfill target below — no row needs
-- inspecting to classify it.

-- CreateEnum
CREATE TYPE "ConsentPolicyKind" AS ENUM ('use_policy', 'data_sharing');

-- AlterTable: consent_policies
-- The default makes the backfill implicit for existing rows.
ALTER TABLE "consent_policies"
  ADD COLUMN "kind" "ConsentPolicyKind" NOT NULL DEFAULT 'use_policy';

-- Versions are now scoped per kind: `v1` of the use policy and `v1` of the
-- data-sharing consent must be able to coexist, which the old global unique
-- index on (version) forbids.
DROP INDEX IF EXISTS "consent_policies_version_key";
CREATE UNIQUE INDEX "consent_policies_kind_version_key"
  ON "consent_policies"("kind", "version");
CREATE INDEX "consent_policies_kind_active_idx"
  ON "consent_policies"("kind", "active");

-- AlterTable: consent_acceptances
ALTER TABLE "consent_acceptances"
  ADD COLUMN "kind" "ConsentPolicyKind" NOT NULL DEFAULT 'use_policy';

CREATE INDEX "consent_acceptances_user_id_kind_idx"
  ON "consent_acceptances"("user_id", "kind");

-- AlterTable: users — the data-sharing counterpart of the existing
-- consented_at / consented_policy_version pair. Deliberately left NULL for
-- existing users rather than backfilled from their use-policy acceptance:
-- nobody has actually agreed to the sharing consent yet, and claiming
-- otherwise would fabricate a consent record. Those users are re-prompted by
-- the post-login consent gate, which is exactly what that gate is for.
ALTER TABLE "users"
  ADD COLUMN "sharing_consented_at" TIMESTAMPTZ(6),
  ADD COLUMN "sharing_consented_policy_version" VARCHAR(64);

-- Seed the data-sharing policy so signup has an active version to validate
-- against the moment this migration lands — without it, every signup would
-- fail its consent check until the seed script is next run. Placeholder text
-- mirrors the existing use-policy seed and is replaced when the buyer
-- supplies the real copy.
INSERT INTO "consent_policies" ("id", "kind", "version", "text", "active", "created_at")
SELECT uuidv7(), 'data_sharing', 'v1',
       'Buyer-supplied data-sharing consent — placeholder text seeded until the real copy is provided.',
       true, now()
WHERE NOT EXISTS (
  SELECT 1 FROM "consent_policies" WHERE "kind" = 'data_sharing' AND "version" = 'v1'
);

-- No new GRANTs: both tables are already granted to cnap_app at table level
-- (see 20260713031212_rls_domain), and column additions inherit that. RLS on
-- consent_acceptances is keyed on org_id, which is unchanged.
