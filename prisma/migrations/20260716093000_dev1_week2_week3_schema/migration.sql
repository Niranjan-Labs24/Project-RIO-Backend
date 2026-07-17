-- Hand-written (prisma migrate dev requires a TTY, unavailable in this
-- environment) — same convention already used elsewhere in this history.
--
-- Squashed migration for the Week 2/3 Dev1 (new-modules) backend pass:
-- Consent versioning, Domain/Sub-Domain Master, Methodology Configuration,
-- Publish Survey + Citizen public flow, Response Quality/AI Summary,
-- Priority Dashboard, Sharing, and Reports (RPT-01..13). Originally shipped
-- as 9 separate incremental migrations during that pass; combined here into
-- one coherent schema change for a cleaner history, with the two
-- forgot-the-GRANT fixups folded directly into the CREATE TABLE they belong
-- to instead of standing alone as separate patches.

-- ============================================================
-- Consent: moves from signup-time to post-first-login. Signup no longer
-- stamps consented_at or writes a consent_acceptances row (see
-- AuthRepository.createOrganisationAndAdmin). This column carries the
-- policy version a user's consented_at corresponds to, denormalized
-- alongside it so a policy version bump can be detected on every
-- login/me() call without an extra join against consent_acceptances.
-- ============================================================
ALTER TABLE "users" ADD COLUMN "consented_policy_version" VARCHAR(64);

-- ============================================================
-- Domain/Sub-Domain Master Module: global reference/master data, no org_id,
-- no RLS — same pattern as "roles"/"consent_policies". Seeded separately
-- from question-bank-v1.json's Domain/Sub-Domain hierarchy only.
-- ============================================================
CREATE TABLE "domains" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domains_code_key" ON "domains"("code");

CREATE TABLE "sub_domains" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "domain_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sub_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sub_domains_code_key" ON "sub_domains"("code");
CREATE INDEX "sub_domains_domain_id_idx" ON "sub_domains"("domain_id");

ALTER TABLE "sub_domains" ADD CONSTRAINT "sub_domains_domain_id_fkey"
  FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Runtime grants for cnap_app (NOBYPASSRLS) — full CRUD (no DELETE: retired
-- rows are deactivated via is_active, never removed).
GRANT SELECT, INSERT, UPDATE ON "domains", "sub_domains" TO cnap_app;

-- Cross-org read-only supervisor access, same as every other reference table.
GRANT SELECT ON "domains", "sub_domains" TO cnap_supervisor;

-- ============================================================
-- Methodology Configuration: global reference/master data (no org_id, no
-- RLS — same pattern as roles/consent_policies/domains). Single-row table —
-- the app always reads/updates the one existing row, seeded below. Final
-- shape includes version publish-tracking (status/publishedBy/publishedAt)
-- and the 9 Priority Scoring factor weights (previously hardcoded in
-- priority.placeholder.ts's FACTOR_DEFS), both added directly rather than
-- via a follow-up ALTER, since this is a squashed pre-merge migration.
-- ============================================================
CREATE TYPE "MethodologyStatus" AS ENUM ('draft', 'published');

CREATE TABLE "methodology_configs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "version" VARCHAR(100) NOT NULL,
    "status" "MethodologyStatus" NOT NULL DEFAULT 'draft',
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(6),
    "priority_thresholds" JSONB NOT NULL,
    "priority_factor_weights" JSONB NOT NULL,
    "confidence_flag_settings" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "methodology_configs_pkey" PRIMARY KEY ("id")
);

GRANT SELECT, INSERT, UPDATE ON "methodology_configs" TO cnap_app;
GRANT SELECT ON "methodology_configs" TO cnap_supervisor;

INSERT INTO "methodology_configs" (
  "id", "version", "priority_thresholds", "priority_factor_weights", "confidence_flag_settings", "updated_at"
) VALUES (
  uuidv7(),
  'v1.0 - Approved implementation baseline',
  '{"criticalSeverity": 80, "highSeverity": 70, "mediumSeverity": 40, "equityHighSeverity": 50}',
  '[
    {"key": "severity", "label": "Severity", "weight": 0.2},
    {"key": "affected_population", "label": "Affected population", "weight": 0.15},
    {"key": "service_availability_gap", "label": "Service availability gap", "weight": 0.12},
    {"key": "urgency", "label": "Urgency", "weight": 0.12},
    {"key": "data_confidence", "label": "Data confidence", "weight": 0.1},
    {"key": "frequency", "label": "Frequency of similar needs", "weight": 0.1},
    {"key": "geographic_coverage", "label": "Geographic coverage", "weight": 0.08},
    {"key": "vulnerable_groups", "label": "Vulnerable groups (equity)", "weight": 0.08},
    {"key": "strategic_alignment", "label": "Strategic alignment", "weight": 0.05}
  ]'::jsonb,
  '{"dontKnowRatioThreshold": 0.2, "minRespondentsForStandardConfidence": 10}',
  CURRENT_TIMESTAMP
);

-- ============================================================
-- Publish Survey + Generate QR (admin-facing) and the Citizen public flow
-- (unauthenticated: resolve token -> OTP -> submit response). Tenant-scoped
-- (org_id + RLS), same isolation pattern as studies/needs/evidence, even
-- though the citizen-facing routes are unauthenticated — see the
-- PublicSurveyLink model comment in schema.prisma for how writes stay
-- RLS-safe without a signed-in actor. `consumed_at` on the OTP challenge
-- (closing off resubmission via a still-known challengeId) is included
-- directly here rather than as a later ALTER.
-- ============================================================
CREATE TABLE "public_survey_links" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "token" VARCHAR(64) NOT NULL,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_survey_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_survey_links_token_key" ON "public_survey_links"("token");
CREATE INDEX "public_survey_links_org_id_idx" ON "public_survey_links"("org_id");
CREATE INDEX "public_survey_links_study_id_idx" ON "public_survey_links"("study_id");

CREATE TABLE "citizen_otp_challenges" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "survey_link_id" UUID NOT NULL,
    "contact" VARCHAR(320) NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citizen_otp_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "citizen_otp_challenges_org_id_idx" ON "citizen_otp_challenges"("org_id");
CREATE INDEX "citizen_otp_challenges_survey_link_id_idx" ON "citizen_otp_challenges"("survey_link_id");

CREATE TABLE "survey_responses" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_link_id" UUID NOT NULL,
    "contact_name" VARCHAR(200),
    "contact" VARCHAR(320) NOT NULL,
    "answers" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "survey_responses_org_id_idx" ON "survey_responses"("org_id");
CREATE INDEX "survey_responses_study_id_idx" ON "survey_responses"("study_id");
CREATE INDEX "survey_responses_survey_link_id_idx" ON "survey_responses"("survey_link_id");

ALTER TABLE "public_survey_links" ADD CONSTRAINT "public_survey_links_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public_survey_links" ADD CONSTRAINT "public_survey_links_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "citizen_otp_challenges" ADD CONSTRAINT "citizen_otp_challenges_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "citizen_otp_challenges" ADD CONSTRAINT "citizen_otp_challenges_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_link_id_fkey"
  FOREIGN KEY ("survey_link_id") REFERENCES "public_survey_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) — same fail-closed NULLIF policy as
-- every other org_id-keyed table (see 20260714120000_week2_data_capture).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public_survey_links','citizen_otp_challenges','survey_responses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid);',
      t || '_org_isolation', t);
  END LOOP;
END $$;

-- Runtime grants for cnap_app (NOBYPASSRLS). No DELETE — citizen data is
-- retained/archived, not deleted (Study/Report Archive picks this up).
GRANT SELECT, INSERT, UPDATE ON "public_survey_links", "citizen_otp_challenges", "survey_responses" TO cnap_app;

-- Cross-org read policies for cnap_supervisor: (1) Center Supervisor's
-- ordinary read access, same pattern as every other table, and (2) the
-- mechanism the unauthenticated citizen routes use to resolve which org a
-- token belongs to before any org context exists yet (see
-- TenantPrismaService.runAsSupervisor). The matching plain GRANT SELECT is
-- included directly here (an RLS policy alone doesn't grant table access;
-- Postgres checks both) — this used to be a separate follow-up migration
-- when the gap was first discovered, folded in here now that it's squashed.
CREATE POLICY public_survey_links_supervisor_read ON "public_survey_links" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY citizen_otp_challenges_supervisor_read ON "citizen_otp_challenges" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY survey_responses_supervisor_read ON "survey_responses" FOR SELECT TO cnap_supervisor USING (true);
GRANT SELECT ON "public_survey_links", "citizen_otp_challenges", "survey_responses" TO cnap_supervisor;

-- ============================================================
-- Response Quality + AI Summary, Priority Dashboard, Sharing Requests, and
-- the Reports Module (RPT-01..13), combined into one migration since all
-- four were added in the same pass — same "combine same-pass features"
-- convention as 20260714120000_week2_data_capture.
-- ============================================================
CREATE TYPE "ConfidenceFlag" AS ENUM ('standard', 'low');
CREATE TYPE "PriorityLevel" AS ENUM ('critical', 'high', 'medium', 'low');
CREATE TYPE "SharingStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');
CREATE TYPE "ReportType" AS ENUM (
  'RPT01','RPT02','RPT03','RPT04','RPT05','RPT06','RPT07','RPT08','RPT09','RPT10','RPT11','RPT12','RPT13'
);
CREATE TYPE "ReportStatus" AS ENUM ('draft', 'approved', 'rejected');

CREATE TABLE "response_quality_results" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "survey_response_id" UUID NOT NULL,
    "completeness_score" INTEGER NOT NULL,
    "missing_fields" TEXT[] NOT NULL DEFAULT '{}',
    "confidence_flag" "ConfidenceFlag" NOT NULL,
    "is_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "duplicate_of_id" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "response_quality_results_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "response_quality_results_org_id_idx" ON "response_quality_results"("org_id");
CREATE INDEX "response_quality_results_study_id_idx" ON "response_quality_results"("study_id");

CREATE TABLE "ai_summaries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "summary_text" TEXT NOT NULL,
    "response_count" INTEGER NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_summaries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_summaries_org_id_idx" ON "ai_summaries"("org_id");
CREATE INDEX "ai_summaries_study_id_idx" ON "ai_summaries"("study_id");

CREATE TABLE "priority_scores" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "level" "PriorityLevel" NOT NULL,
    "gap_type" VARCHAR(50) NOT NULL,
    "factors" JSONB NOT NULL,
    "cycle_note" VARCHAR(200),
    "scored_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "priority_scores_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "priority_scores_org_id_idx" ON "priority_scores"("org_id");
CREATE INDEX "priority_scores_study_id_idx" ON "priority_scores"("study_id");

-- No RLS on this table (see the SharingRequest model comment in
-- schema.prisma) — visible to both owner and requester orgs, plus the
-- cross-entity Center Supervisor. Authorization is service-layer enforced.
CREATE TABLE "sharing_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "owner_org_id" UUID NOT NULL,
    "requesting_org_id" UUID NOT NULL,
    "study_id" UUID NOT NULL,
    "status" "SharingStatus" NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "note" VARCHAR(1000),

    CONSTRAINT "sharing_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sharing_requests_owner_org_id_idx" ON "sharing_requests"("owner_org_id");
CREATE INDEX "sharing_requests_requesting_org_id_idx" ON "sharing_requests"("requesting_org_id");
CREATE INDEX "sharing_requests_study_id_idx" ON "sharing_requests"("study_id");

CREATE TABLE "reports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "report_type" "ReportType" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'draft',
    "title" VARCHAR(300) NOT NULL,
    "study_id" UUID,
    "filters" JSONB NOT NULL,
    "content" JSONB NOT NULL,
    "generated_by" UUID NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reports_org_id_idx" ON "reports"("org_id");
CREATE INDEX "reports_report_type_idx" ON "reports"("report_type");

ALTER TABLE "response_quality_results" ADD CONSTRAINT "response_quality_results_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "response_quality_results" ADD CONSTRAINT "response_quality_results_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "response_quality_results" ADD CONSTRAINT "response_quality_results_survey_response_id_fkey"
  FOREIGN KEY ("survey_response_id") REFERENCES "survey_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_summaries" ADD CONSTRAINT "ai_summaries_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sharing_requests" ADD CONSTRAINT "sharing_requests_owner_org_id_fkey"
  FOREIGN KEY ("owner_org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sharing_requests" ADD CONSTRAINT "sharing_requests_requesting_org_id_fkey"
  FOREIGN KEY ("requesting_org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sharing_requests" ADD CONSTRAINT "sharing_requests_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_study_id_fkey"
  FOREIGN KEY ("study_id") REFERENCES "studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (RIO-NFR-003 pattern) for the 3 normal org-scoped
-- tables. sharing_requests is deliberately excluded — see its model
-- comment; it stays app-layer authorized, not RLS-scoped.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['response_quality_results','ai_summaries','priority_scores','reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.current_org_id'', true), '''')::uuid);',
      t || '_org_isolation', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON "response_quality_results", "ai_summaries", "priority_scores", "reports" TO cnap_app;
CREATE POLICY response_quality_results_supervisor_read ON "response_quality_results" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY ai_summaries_supervisor_read ON "ai_summaries" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY priority_scores_supervisor_read ON "priority_scores" FOR SELECT TO cnap_supervisor USING (true);
CREATE POLICY reports_supervisor_read ON "reports" FOR SELECT TO cnap_supervisor USING (true);
GRANT SELECT ON "response_quality_results", "ai_summaries", "priority_scores", "reports" TO cnap_supervisor;

-- sharing_requests has no RLS (see above) — cnap_app gets plain CRUD (no
-- DELETE: a rejected/expired request stays as an auditable record), and
-- cnap_supervisor gets the same plain SELECT every other table gets, which
-- is sufficient here since there's no RLS policy gating it.
GRANT SELECT, INSERT, UPDATE ON "sharing_requests" TO cnap_app;
GRANT SELECT ON "sharing_requests" TO cnap_supervisor;
