-- Methodology Settings fix — LIV-21 household income bands.
--
-- The methodology (question-bank-v5.json / Scoring Lookup) has nine answers:
-- six income bands plus No income, Irregular and Prefer not to answer. The
-- Arabic options were imported from an older source that still had the two
-- old bands (less than / more than SAR 5,000), and Arabic options are matched
-- to the English ones by position, so an Arabic respondent saw the old bands
-- and the last four options had no Arabic at all.
--
-- This sets both option lists to the nine answers, in the same order, and
-- adds any missing LIV-21 scoring row for every methodology version that has
-- a scoring lookup. Existing scoring rows are left as they are. No schema
-- change.

UPDATE "questions"
SET "answer_options" = '["Less than SAR 2,000", "SAR 2,000–3,999", "SAR 4,000–5,999", "SAR 6,000–7,999", "SAR 8,000–11,999", "SAR 12,000 or more", "No income", "Irregular — cannot be estimated", "Prefer not to answer"]'::jsonb
WHERE "question_id" = 'LIV-21'
  AND "answer_options" IS DISTINCT FROM '["Less than SAR 2,000", "SAR 2,000–3,999", "SAR 4,000–5,999", "SAR 6,000–7,999", "SAR 8,000–11,999", "SAR 12,000 or more", "No income", "Irregular — cannot be estimated", "Prefer not to answer"]'::jsonb;

UPDATE "questions"
SET "answer_options_ar" = '["أقل من 2,000 ريال", "2,000–3,999 ريال", "4,000–5,999 ريال", "6,000–7,999 ريال", "8,000–11,999 ريال", "12,000 ريال أو أكثر", "لا يوجد دخل", "غير منتظم — يتعذر التقدير", "أفضّل عدم الإجابة"]'::jsonb
WHERE "question_id" = 'LIV-21'
  AND "answer_options_ar" IS DISTINCT FROM '["أقل من 2,000 ريال", "2,000–3,999 ريال", "4,000–5,999 ريال", "6,000–7,999 ريال", "8,000–11,999 ريال", "12,000 ريال أو أكثر", "لا يوجد دخل", "غير منتظم — يتعذر التقدير", "أفضّل عدم الإجابة"]'::jsonb;

INSERT INTO "scoring_lookups"
  ("methodology_version_id", "question_id", "lookup_type", "option_id", "option_order",
   "severity_score", "is_excluded", "exclusion_reason", "is_active", "updated_at")
SELECT mv."methodology_version_id", 'LIV-21', 'OPTION', v.option_id, v.option_order,
       v.severity_score, v.is_excluded, v.exclusion_reason, true, now()
FROM (SELECT DISTINCT "methodology_version_id" FROM "scoring_lookups") mv
CROSS JOIN (VALUES
  ('LESS_THAN_SAR_2_000',           1, 100.00::numeric, false, NULL::varchar),
  ('SAR_2_000_3_999',               2,  80.00, false, NULL),
  ('SAR_4_000_5_999',               3,  60.00, false, NULL),
  ('SAR_6_000_7_999',               4,  40.00, false, NULL),
  ('SAR_8_000_11_999',              5,  20.00, false, NULL),
  ('SAR_12_000_OR_MORE',            6,   0.00, false, NULL),
  ('IRREGULAR_CANNOT_BE_ESTIMATED', 7,  70.00, false, NULL),
  ('NO_INCOME',                     8, 100.00, false, NULL),
  ('PREFER_NOT_TO_ANSWER',          9,   NULL, true,  'PREFER_NOT_TO_ANSWER')
) AS v(option_id, option_order, severity_score, is_excluded, exclusion_reason)
WHERE NOT EXISTS (
  SELECT 1 FROM "scoring_lookups" s
  WHERE s."methodology_version_id" = mv."methodology_version_id"
    AND s."question_id" = 'LIV-21'
    AND s."option_id" = v.option_id
);
