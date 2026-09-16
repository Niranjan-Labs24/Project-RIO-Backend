-- RIO-FR-003 — classification by sector and urgency, recurring themes, and an
-- explainable priority score with a reviewer sign-off gate.
--
-- Additive only. Every column is nullable or defaulted, so existing needs and
-- scores keep working untouched: an old Need has no urgency and no themes, and
-- an old PriorityScore has no override — all three read back as "not set",
-- which is exactly what they are.

-- ── Need: urgency + recurring themes ────────────────────────────────────────

-- Free-text VARCHAR rather than a Postgres enum, matching Need.gapType above.
-- The allowed values are validated in the contract layer and their 0-100
-- mapping lives in methodology config, so adding a level later is a config
-- change and a contract change, not a migration.
ALTER TABLE "needs" ADD COLUMN "urgency" VARCHAR(30);

-- A real TEXT[], following "needs"."village". Never a comma-joined string:
-- themes are filtered and grouped on, and a joined string cannot be indexed
-- or matched element-wise.
ALTER TABLE "needs" ADD COLUMN "themes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AC 6 filters and groups needs by theme, and the recurrence factor counts how
-- many needs share one. Both are array-containment queries, which is what GIN
-- indexes exist for.
CREATE INDEX "needs_themes_idx" ON "needs" USING GIN ("themes");

-- ── PriorityScore: the reviewer override, kept beside the computed value ────

-- AC 5 requires the override to stay DISTINGUISHABLE from what the system
-- computed, so these are new columns rather than an update to "overall_score".
-- "overall_score" remains the engine's own number for the life of the row.
ALTER TABLE "priority_scores" ADD COLUMN "override_score" INTEGER;
ALTER TABLE "priority_scores" ADD COLUMN "override_reason" TEXT;
ALTER TABLE "priority_scores" ADD COLUMN "overridden_by" UUID;
ALTER TABLE "priority_scores" ADD COLUMN "overridden_at" TIMESTAMPTZ(6);

-- An override without a reason is exactly what AC 5 forbids, and a reason
-- without an override is a note nobody asked for. Enforced here as well as in
-- the service so no future write path can bypass it.
ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_override_needs_reason"
  CHECK (
    ("override_score" IS NULL AND "override_reason" IS NULL)
    OR ("override_score" IS NOT NULL AND "override_reason" IS NOT NULL)
  );

-- ── MethodologyConfig: raw value → 0-100 conversion rules ───────────────────

-- The weights already live in "priority_factor_weights". This is the other
-- half: what a raw figure is worth out of 100 before its weight applies.
-- Seeded with the methodology's own defaults so scoring works on day one, and
-- editable afterwards (RIO-NFR-014).
ALTER TABLE "methodology_configs" ADD COLUMN "priority_factor_scales" JSONB
  NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "methodology_config_history" ADD COLUMN "priority_factor_scales" JSONB
  NOT NULL DEFAULT '{}'::jsonb;

-- The four axes, their domain links and the individually-named KPI exceptions
-- are the workbook's own (METH - Factors & Multipliers). The workbook states
-- them as MULTIPLIERS (1.30 / 1.20 / 1.15 / 1.10) applied to a priority score;
-- the 9-factor model needs them as a 0-100 FACTOR VALUE instead, so each is
-- normalised over the workbook's own ceiling:
--
--     value = (multiplier - 1.00) / 0.30 * 100
--     1.30 -> 100    1.20 -> 67    1.15 -> 50    1.10 -> 33
--
-- That keeps the ordering and the relative spacing the workbook chose, without
-- inventing numbers of our own. The 0.30 denominator is the workbook's stated
-- x1.30 ceiling, not an arbitrary pick.
--
-- The questionIds are the workbook's "tagged individually" exceptions,
-- translated from its v1.0 codes to v5.0 via the question bank's formerCode
-- map (SR-03->GOV-11, SD07->SOC-07, IN09->INF-10, LV12->LIV-13, and so on).
-- A need whose question is in one of those lists takes that axis even when its
-- domain points elsewhere, which is the cross-cutting case the workbook's
-- safeguard 4 calls out.
UPDATE "methodology_configs"
SET "priority_factor_scales" = '{
  "urgency": {
    "immediate": 100,
    "this_cycle": 70,
    "next_cycle": 40,
    "no_fixed_timeline": 10
  },
  "affectedPopulation": { "floor": 0, "ceiling": 1000 },
  "geographicCoverage": { "floor": 1, "ceiling": 10 },
  "frequency": { "floor": 1, "ceiling": 20 },
  "strategicAxes": [
    { "key": "non_profit_empowerment", "label": "Non-profit sector empowerment", "value": 100,
      "domains": ["Governance & Services"],
      "questionIds": ["GOV-11", "GOV-12", "SOC-07", "SOC-11", "GOV-05", "GOV-06"] },
    { "key": "diversified_economy", "label": "Diversified local economy", "value": 67,
      "domains": ["Livelihood", "Culture"],
      "questionIds": ["INF-10", "INF-06"] },
    { "key": "human_capability", "label": "Human capability and empowerment", "value": 50,
      "domains": ["Education", "Social Development"],
      "questionIds": ["LIV-13", "LIV-14", "LIV-15", "LIV-16", "LIV-17", "LIV-20"] },
    { "key": "essential_services", "label": "Essential services", "value": 33,
      "domains": ["Health", "Water & Sanitation", "Energy & Environment", "Infrastructure"],
      "questionIds": [] }
  ]
}'::jsonb
WHERE "priority_factor_scales" = '{}'::jsonb;

-- ── Theme vocabulary ────────────────────────────────────────────────────────

-- Closed vocabulary for AC 6's theme extraction. Global reference table, same
-- shape as "study_type_options", so it reuses the existing Methodology
-- Configuration CRUD screen with no new UI.
CREATE TABLE "need_theme_options" (
  "id"            UUID PRIMARY KEY DEFAULT uuidv7(),
  "name"          VARCHAR(100) NOT NULL UNIQUE,
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "is_active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL
);

GRANT SELECT ON "need_theme_options" TO cnap_app;
GRANT SELECT ON "need_theme_options" TO cnap_supervisor;

-- Seeded from the nine domains' recurring cross-cutting problems, so theme
-- extraction and the recurrence factor work on day one. A System Admin can
-- rename, retire or extend these from Methodology Configuration; needs store
-- the theme name as text, so retiring one never breaks an existing need.
INSERT INTO "need_theme_options" ("name", "display_order", "updated_at") VALUES
  ('Distance to facility',        10, now()),
  ('Transport availability',      20, now()),
  ('Service not available',       30, now()),
  ('Service quality',             40, now()),
  ('Staffing shortage',           50, now()),
  ('Supply or stock shortage',    60, now()),
  ('Affordability and cost',      70, now()),
  ('Water availability',          80, now()),
  ('Water quality',               90, now()),
  ('Sanitation and hygiene',     100, now()),
  ('Electricity and energy',     110, now()),
  ('Road and connectivity',      120, now()),
  ('Digital connectivity',       130, now()),
  ('School access and dropout',  140, now()),
  ('Learning materials',         150, now()),
  ('Skills and employability',   160, now()),
  ('Income and livelihood',      170, now()),
  ('Market access',              180, now()),
  ('Awareness and information',  190, now()),
  ('Participation and voice',    200, now()),
  ('Women and girls',            210, now()),
  ('Children and youth',         220, now()),
  ('Elderly and disability',     230, now()),
  ('Safety and risk',            240, now()),
  ('Heritage and culture',       250, now())
ON CONFLICT ("name") DO NOTHING;

-- The equity threshold: how wide a spread between respondent segments counts
-- as inequity. The methodology says results must differ "materially" between
-- sex / age / disability but never gives a number, so it belongs with the
-- other configurable rules rather than baked into scoring code.
UPDATE "methodology_configs"
SET "priority_factor_scales" =
  jsonb_set("priority_factor_scales", '{equitySpreadThreshold}', '50'::jsonb, true)
WHERE NOT ("priority_factor_scales" ? 'equitySpreadThreshold');
