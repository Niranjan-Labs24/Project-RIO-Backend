-- SVB-02 (UAT v1.4): KPI code numbering.
-- Before: a KPI showed the same code as its parent Indicator (e.g. "HLT-01").
-- Now: each KPI gets its own code, [indicator code]-[nn] (two digits, e.g. HLT-01-01), numbered in the
-- order the KPIs appear in the approved methodology.
--   * indicator_code — the parent Indicator's code: the first question code
--     (methodology order) under that Domain / Sub-domain / Indicator.
--   * kpi_code — indicator_code + "-" + the KPI's two-digit position under it
--     (client-confirmed format, e.g. HLT-01-01, HLT-01-02). A KPI
--     is identified by its own anchor code (the text before " — "), so the
--     enrichment questions that feed the same KPI share its code.
-- Domain, Sub-domain, Indicator and Question codes are unchanged. kpi_code is
-- a display label only: scores, roll-ups and reports still key on the KPI
-- itself, so nothing breaks if a KPI is moved — the codes are recomputed
-- (KpiCodesService) whenever the question bank changes.
ALTER TABLE "questions" ADD COLUMN "indicator_code" VARCHAR(64);
ALTER TABLE "questions" ADD COLUMN "kpi_code" VARCHAR(80);

WITH q AS (
  SELECT id, methodology_version_id AS mv, domain, sub_domain, btrim(indicator) AS indicator,
         nullif(btrim(split_part(kpi, ' — ', 1)), '') AS kpi_key, question_id,
         row_number() OVER (
           PARTITION BY methodology_version_id
           ORDER BY regexp_replace(upper(question_id), '[0-9]+$', ''),
                    coalesce(substring(question_id FROM '([0-9]+)$')::int, 0),
                    question_id
         ) AS ord
  FROM "questions"
  WHERE indicator IS NOT NULL AND btrim(indicator) <> ''
),
ind AS (
  SELECT DISTINCT ON (mv, domain, sub_domain, indicator) mv, domain, sub_domain, indicator, question_id AS indicator_code
  FROM q
  ORDER BY mv, domain, sub_domain, indicator, ord
),
k AS (
  SELECT mv, domain, sub_domain, indicator, kpi_key,
         dense_rank() OVER (PARTITION BY mv, domain, sub_domain, indicator ORDER BY min(ord)) AS n
  FROM q
  WHERE kpi_key IS NOT NULL
  GROUP BY mv, domain, sub_domain, indicator, kpi_key
)
UPDATE "questions" t
SET indicator_code = ind.indicator_code,
    kpi_code = CASE WHEN k.n IS NULL THEN NULL ELSE ind.indicator_code || '-' || lpad(k.n::text, 2, '0') END
FROM q
JOIN ind ON ind.mv = q.mv AND ind.domain = q.domain AND ind.sub_domain = q.sub_domain AND ind.indicator = q.indicator
LEFT JOIN k ON k.mv = q.mv AND k.domain = q.domain AND k.sub_domain = q.sub_domain AND k.indicator = q.indicator AND k.kpi_key = q.kpi_key
WHERE t.id = q.id;
