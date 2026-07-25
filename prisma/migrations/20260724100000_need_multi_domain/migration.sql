-- Multi-select Domain/Sub-domain support for a Need. Need.domain/sub_domain
-- stay in place (always kept in sync with the first need_domains row — see
-- schema.prisma comment), so any reader not yet migrated to the new list
-- keeps working with at least the primary domain.

-- AlterTable
ALTER TABLE "needs" ADD COLUMN "all_domains_selected" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
-- Multi-select Domain/Sub-domain pairs for a Need — same org-scoped
-- join-table pattern as need_governorates/need_centers. Plain name
-- strings (not a relation to domains/sub_domains), same convention as
-- needs.domain/sub_domain and ai_decisions.suggestion.
CREATE TABLE "need_domains" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "need_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "domain" VARCHAR(120) NOT NULL,
    "sub_domain" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "need_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "need_domains_org_id_idx" ON "need_domains"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "need_domains_need_id_domain_sub_domain_key" ON "need_domains"("need_id", "domain", "sub_domain");

-- AddForeignKey
ALTER TABLE "need_domains" ADD CONSTRAINT "need_domains_need_id_fkey" FOREIGN KEY ("need_id") REFERENCES "needs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Org-scoped join table — same RLS isolation pattern as need_governorates/
-- need_centers.
ALTER TABLE "need_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "need_domains" FORCE ROW LEVEL SECURITY;

CREATE POLICY need_domains_org_isolation ON "need_domains"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "need_domains" TO cnap_app;
GRANT SELECT ON "need_domains" TO cnap_supervisor;

CREATE POLICY need_domains_supervisor_read ON "need_domains" FOR SELECT TO cnap_supervisor USING (true);
