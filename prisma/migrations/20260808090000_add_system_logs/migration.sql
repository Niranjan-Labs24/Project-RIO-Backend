-- RIO-NFR-016 — purely additive: two new enums, one new PermissionModule
-- value, one new table. Nothing existing is altered or dropped.
--
-- system_logs: persisted operational telemetry (errors, failed
-- integrations, slow/failed requests, job outcomes) so that the NFR-016
-- acceptance criterion — "logged in a queryable manner" — is met by an API
-- and a screen rather than by shell access to the container's stdout. The
-- pino/stdout pipeline (common/logger/logger.config.ts) is unchanged and
-- stays the source of truth for debug/trace; this table is the queryable
-- subset (info and above, successful requests sampled).
--
-- Deliberately NOT audit_logs (RIO-FR-007): that table's own acceptance
-- criterion is that it cannot be deleted, and operational telemetry needs a
-- retention purge. Different volume, audience, and lifetime.
--
-- No RLS org-isolation policy here, on purpose: organisation_id is a
-- correlation field, not an ownership field, and the table is read only
-- through the cross-org supervisor client behind a permission only System
-- Admin holds. Grants do the confinement instead — cnap_app may INSERT
-- (never SELECT), cnap_supervisor may SELECT. Same "global table, no RLS"
-- pattern as ncnp_report_reviews.
--
-- PermissionModule.systemLogs: a dedicated module rather than reusing
-- archiveSharingAudit, which would expose stack traces and integration
-- detail to ngo_admin, center_supervisor and data_analyst.

-- Trigram search over `message` (the screen's search box). Guarded so the
-- migration still applies on an environment where it already exists.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "SystemLogLevel" AS ENUM ('fatal', 'error', 'warn', 'info');

-- CreateEnum
CREATE TYPE "SystemLogCategory" AS ENUM (
  'http', 'database', 'auth', 'integration', 'job', 'startup', 'security', 'application'
);

-- AlterEnum
-- IF NOT EXISTS: a `prisma db push` against a dev database can already have
-- added this value from schema.prisma, and enum values cannot be removed —
-- without the guard this migration would be unrunnable on any such database.
ALTER TYPE "PermissionModule" ADD VALUE IF NOT EXISTS 'systemLogs';

-- CreateTable
CREATE TABLE "system_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "level" "SystemLogLevel" NOT NULL,
    "category" "SystemLogCategory" NOT NULL,
    "source" VARCHAR(120) NOT NULL,
    "event_code" VARCHAR(80),
    "message" VARCHAR(2000) NOT NULL,
    "request_id" VARCHAR(64),
    "organisation_id" UUID,
    "actor_user_id" UUID,
    "http_method" VARCHAR(10),
    "http_path" VARCHAR(500),
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "stack" TEXT,
    "context" JSONB,
    "instance_id" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_logs_created_at_idx" ON "system_logs"("created_at");

-- CreateIndex
CREATE INDEX "system_logs_level_created_at_idx" ON "system_logs"("level", "created_at");

-- CreateIndex
CREATE INDEX "system_logs_category_created_at_idx" ON "system_logs"("category", "created_at");

-- CreateIndex
CREATE INDEX "system_logs_event_code_idx" ON "system_logs"("event_code");

-- CreateIndex
CREATE INDEX "system_logs_request_id_idx" ON "system_logs"("request_id");

-- CreateIndex
CREATE INDEX "system_logs_organisation_id_idx" ON "system_logs"("organisation_id");

-- Free-text search over the message body. Not a Prisma-managed index (no
-- @@index equivalent for GIN/trigram) — kept here deliberately so the
-- search box stays usable as the table grows.
CREATE INDEX "system_logs_message_trgm_idx" ON "system_logs" USING GIN ("message" gin_trgm_ops);

-- Runtime grants.
--
-- cnap_app: INSERT (every call site writes through it), plus DELETE and a
-- deliberately COLUMN-LEVEL SELECT on just (id, created_at) for the
-- retention purge. Postgres requires SELECT on every column a DELETE's
-- WHERE clause touches, so the purge needs created_at — but nothing in a
-- request path has any business reading message/stack/context back, and
-- the column grant is what enforces that rather than convention.
--
-- cnap_supervisor: full SELECT — this is the read path the API serves the
-- System Logs screen from, and it stays SELECT-only (no DELETE here, so a
-- read connection can never destroy operational history).
GRANT INSERT, DELETE ON "system_logs" TO cnap_app;
GRANT SELECT ("id", "created_at") ON "system_logs" TO cnap_app;
GRANT SELECT ON "system_logs" TO cnap_supervisor;
