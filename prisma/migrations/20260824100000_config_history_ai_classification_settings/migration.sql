-- RIO-NFR-017 asks for a history of EVERY methodology configuration change.
-- methodology_config_history was authored against the three settings families
-- that existed at the time; ai_classification_settings (RIO-AI-001) landed in
-- parallel on another branch, so without this column an edit that changed
-- only an AI confidence threshold would write a history row that records no
-- change at all — the timeline would show an "edit" with nothing different
-- from the entry before it.
--
-- Separate migration rather than an edit to
-- 20260824090000_ai_classification_confidence_settings: that one is already
-- applied in dev, and a shared migration is immutable history.
--
-- The DEFAULT backfills rows written before this column with the same
-- documented defaults MethodologyConfigService.readAiClassificationSettings
-- falls back to, which is a true statement about those rows: nothing else
-- was configurable when they were recorded.
ALTER TABLE "methodology_config_history"
  ADD COLUMN "ai_classification_settings" JSONB NOT NULL
  DEFAULT '{"lowConfidenceThreshold": 0.7, "veryLowConfidenceThreshold": 0.4}'::jsonb;
