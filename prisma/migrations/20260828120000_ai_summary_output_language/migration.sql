-- RIO-I18N-003 §9 — record, and key on, the language a generated narrative is in.
--
-- A report's LABELS and FIGURES are translated at export time, so one approved
-- report renders as both language editions with identical numbers and one
-- approval. Generated PROSE cannot work that way: the model writes it once, and
-- rewriting it later would move generated_at and invalidate the reviewer's
-- approval. So each language is a separate generated artefact, and the language
-- becomes part of a summary's identity rather than a display detail.
--
-- Without this column the DRAFT/STALE supersede in
-- ReportSummaryService.generatePrioritySummary matched on scope alone, so
-- generating the Arabic summary SUPERSEDED the English one — one officer's
-- language choice silently invalidating another officer's confirmed work.

-- Nullable with NO default, deliberately. Rows written before this shipped
-- genuinely do not record their language; defaulting them to 'en' would assert
-- something untrue about every one of them. A backfill can label them later by
-- running the script detector over ai_output_json — that is a data decision,
-- not a schema one, and it belongs in its own reviewed step.
ALTER TABLE "ai_priority_summaries"
  ADD COLUMN "output_language" VARCHAR(8);

-- Set when the model was asked for one language, answered in another, and did
-- so again on the single quality retry. The narrative is kept and flagged
-- rather than discarded: a usable summary in the wrong language beats no
-- summary, and every one of these is reviewed by a human before release.
-- NOT NULL with a default, because "we did not check" and "we checked and it
-- was fine" are the same thing for every historical row.
ALTER TABLE "ai_priority_summaries"
  ADD COLUMN "language_mismatch" BOOLEAN NOT NULL DEFAULT false;

-- Supports the reuse/supersede predicate now that it filters on language.
CREATE INDEX "ai_priority_summaries_study_survey_village_scope_lang_status_idx"
  ON "ai_priority_summaries" ("study_id", "survey_id", "village_id", "summary_scope", "output_language", "status");
