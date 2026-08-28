-- RIO-AI-001 — "low-confidence suggestions (below a CONFIGURABLE threshold)
-- are visually flagged for closer reviewer attention".
--
-- The two bands existed already, but as literals inside the React component
-- that draws the confidence bar (0.7 / 0.4). That made the acceptance
-- criterion impossible to meet: nothing an administrator can reach was
-- configurable at all. They move here, alongside priority_thresholds and
-- confidence_flag_settings, so the Methodology Configuration screen owns
-- every methodology threshold in one place instead of two.
--
-- Scale is 0..1, deliberately matching ai_decisions.confidence's own scale
-- rather than the 0-100 severity scale used by priority_thresholds — these
-- gate a model's self-reported confidence, not a severity score, and
-- silently mixing the two scales in one JSON family would be a trap.
--
-- NOT NULL with a DEFAULT: the default is exactly the pair of values the
-- frontend has been applying all along, so this migration changes no
-- observable behaviour — it only makes the existing behaviour editable. The
-- default also backfills the single existing methodology_configs row (and
-- MethodologyConfigService.findRowOrThrow's self-heal insert, which does not
-- name this column when running against an older client).
ALTER TABLE "methodology_configs"
  ADD COLUMN "ai_classification_settings" JSONB NOT NULL
  DEFAULT '{"lowConfidenceThreshold": 0.7, "veryLowConfidenceThreshold": 0.4}'::jsonb;

-- Make a model's self-reported confidence nullable.
--
-- `0` is already a REAL, load-bearing value on this column: the "AI ran and
-- declined to classify" path (AiDecisionsService.runAndPersistClassification's
-- AiClassificationDeclinedError branch) stores 0 to mean "no confidence at
-- all", and the reviewer UI reads that as the all-domains-selected case.
--
-- A model that DID classify but omitted `confidence` from its JSON is a
-- different fact, and classification.ai.ts used to coerce it to 0 — making a
-- perfectly good classification render as the worst possible one, in red, at
-- 0%. NULL now carries "not reported" honestly, and the reviewer UI flags it
-- for closer review instead of showing a fabricated number. (The prompt's
-- response schema now also lists `confidence` as required, so this should be
-- rare — need-classification was the only AI task that had left it optional.)
--
-- No backfill: every existing row's 0 was either a genuine decline or the old
-- coercion, and there is no stored evidence to tell those two apart after the
-- fact. Rewriting them would be a guess, so historical rows keep the value
-- they were recorded with.
ALTER TABLE "ai_decisions" ALTER COLUMN "confidence" DROP NOT NULL;
