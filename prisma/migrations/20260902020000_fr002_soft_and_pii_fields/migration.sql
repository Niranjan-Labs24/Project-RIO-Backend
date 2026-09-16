-- RIO-FR-002 — two corrections to the seeded cleaning rule set, both found by
-- running the rules against this platform's real data before wiring them up.

-- ── 1. softNeedFields: seeded with values that would produce pure noise ────
--
-- The first cut seeded softNeedFields with affectedPopulation, urgency and
-- gapType. Running the rules over the real needs table showed what that would
-- mean on day one: 119 of 121 needs have no affectedPopulation, so the
-- reviewer's queue would open with ~119 flags for a field NOBODY CAN FILL IN.
--
-- Need.affectedPopulation's own comment in schema.prisma says why: the figure
-- "cannot be reconstructed after the fact, because nobody was asked at the
-- time." And Q37's answer is that affected population is to be collected going
-- forward, not derived retroactively. A flag a reviewer can only ever dismiss
-- is not a finding — it is an instruction to ignore the queue.
--
-- The key is kept, not removed: the capability is right and a System Admin can
-- switch any of these on from Methodology Configuration once the field is
-- actually being collected. It just does not ship switched on.
UPDATE "methodology_configs"
SET "data_cleaning_settings" =
  jsonb_set("data_cleaning_settings", '{softNeedFields}', '[]'::jsonb, true);

-- ── 2. piiFields: a category the rule set had no concept of ───────────────
--
-- A cleaning flag normally stores the value it objects to and the value it
-- proposes, so a reviewer can compare them side by side. For a citizen's
-- contact email or mobile number that would copy respondent PII into a second,
-- reviewer-facing table — widening who can read it and where it lives.
--
-- RIO-NFR-002 already forbids putting a respondent's contact details in the
-- audit log for exactly this reason. cleaning_flags is a different table, but
-- the reasoning transfers, and "the audit-log rule does not technically cover
-- this table" is not a privacy argument.
--
-- Fields listed here get a MASKED original and NO proposal on their flags. The
-- reviewer still sees that a number is malformed and what shape it will take;
-- accepting recomputes the normalized value server-side from the live row,
-- which works because the normalizers are pure functions.
UPDATE "methodology_configs"
SET "data_cleaning_settings" =
  jsonb_set(
    "data_cleaning_settings",
    '{piiFields}',
    '["contact", "mobile", "contactName"]'::jsonb,
    true
  );

-- Same two corrections onto the history table's most recent snapshot, so a
-- reader comparing the live config against its latest history row does not see
-- a phantom change on the next real edit.
UPDATE "methodology_config_history" h
SET "data_cleaning_settings" = c."data_cleaning_settings"
FROM "methodology_configs" c
WHERE h."config_id" = c."id"
  AND h."changed_at" = (
    SELECT max("changed_at") FROM "methodology_config_history" WHERE "config_id" = c."id"
  );
