-- RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
-- 2026-09-08. Permanent cache of AI-translated dynamic/user-typed content
-- (Need title/statement, evidence descriptions, decision notes, sharing
-- purposes, ...), content-addressed by a hash of the source text + target
-- locale — see the schema.prisma model comment for the full reasoning.
-- Global reference data, no orgId/RLS (same pattern as domains/sub_domains).

CREATE TABLE "translation_cache" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "cache_key" VARCHAR(64) NOT NULL,
    "source_locale" VARCHAR(5) NOT NULL,
    "target_locale" VARCHAR(5) NOT NULL,
    "source_text" TEXT NOT NULL,
    "translated_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "translation_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "translation_cache_cache_key_key" ON "translation_cache"("cache_key");

GRANT SELECT, INSERT ON "translation_cache" TO cnap_app;
GRANT SELECT ON "translation_cache" TO cnap_supervisor;
