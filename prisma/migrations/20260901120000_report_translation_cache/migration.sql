-- RIO-I18N-007 — the AI report-translation cache.
--
-- Backs the export-time translation pass that removes the last English from an
-- Arabic report: narrative and methodology prose, Question Bank KPI and
-- indicator names (which have no `name_ar` column at all), and the governorate
-- and centre names that RIO-I18N-004 §6 deliberately left in English.
--
-- The table exists for DETERMINISM before it exists for cost. A model is asked
-- about a source string exactly once; every later export of every report reads
-- the answer from here. Without that, two downloads of one approved report
-- could word the same finding differently, and the English and Arabic editions
-- would no longer reconcile — which is the guarantee export-time localisation
-- was built to protect (RIO-RPT-001 AC 2/AC 3).
--
-- `source` is the correction path: a row edited by hand and marked 'human' is
-- never overwritten by the writer, so client-approved terminology survives
-- both a re-export and a prompt change. That is what makes this table the
-- staging ground for the vocabulary NCNP has still to approve, rather than a
-- permanent machine artefact.
--
-- GLOBAL, with no org_id and no row-level security, for the same reason the
-- domain and geography tables are: the methodology's own words must not differ
-- between two tenants' reports.

CREATE TABLE "report_translations" (
    "id"              UUID         NOT NULL DEFAULT uuidv7(),
    "source_hash"     CHAR(64)     NOT NULL,
    "source_text"     TEXT         NOT NULL,
    "locale"          VARCHAR(8)   NOT NULL,
    "translated_text" TEXT         NOT NULL,
    "source"          VARCHAR(16)  NOT NULL DEFAULT 'ai',
    "prompt_version"  VARCHAR(64),
    "model"           VARCHAR(64),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "report_translations_pkey" PRIMARY KEY ("id")
);

-- The lookup, and the one-rendering-per-string-per-language guarantee. On the
-- HASH, not the text: a btree over multi-sentence methodology notes would fail
-- on INSERT at the index row-size limit, and the digest is exact where a
-- truncated text index would not be.
CREATE UNIQUE INDEX "report_translations_source_hash_locale_key"
    ON "report_translations" ("source_hash", "locale");
