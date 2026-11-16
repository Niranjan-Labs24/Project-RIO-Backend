import { Prisma } from '../../generated/prisma';

type RawExecutor = { $executeRaw: (query: Prisma.Sql) => Promise<number> };

/**
 * SVB-02 (UAT v1.4) — recompute every question's indicator code and KPI code
 * for one methodology version. Same rules as the 20261113000200_kpi_codes
 * migration:
 *  - indicator_code: the first question code (methodology order) under the
 *    same Domain / Sub-domain / Indicator;
 *  - kpi_code: indicator_code + "-" + the KPI's two-digit position under that
 *    Indicator, where a KPI is identified by its own anchor code (the text
 *    before " — "), so enrichment questions feeding one KPI share its code.
 * Labels only — scores and reports key on the KPI itself — so this simply
 * rewrites the labels after the question bank changes.
 */
export function recomputeKpiCodes(tx: RawExecutor, methodologyVersionId: string): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
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
      WHERE methodology_version_id = ${methodologyVersionId}::uuid
        AND indicator IS NOT NULL AND btrim(indicator) <> ''
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
    ),
    codes AS (
      SELECT q.id, ind.indicator_code,
             CASE WHEN k.n IS NULL THEN NULL ELSE ind.indicator_code || '-' || lpad(k.n::text, 2, '0') END AS kpi_code
      FROM q
      JOIN ind ON ind.mv = q.mv AND ind.domain = q.domain AND ind.sub_domain = q.sub_domain AND ind.indicator = q.indicator
      LEFT JOIN k ON k.mv = q.mv AND k.domain = q.domain AND k.sub_domain = q.sub_domain AND k.indicator = q.indicator AND k.kpi_key = q.kpi_key
    )
    UPDATE "questions" t
    SET indicator_code = c.indicator_code, kpi_code = c.kpi_code
    FROM (
      SELECT x.id, c.indicator_code, c.kpi_code
      FROM "questions" x
      LEFT JOIN codes c ON c.id = x.id
      WHERE x.methodology_version_id = ${methodologyVersionId}::uuid
    ) c
    WHERE t.id = c.id
      AND (t.indicator_code IS DISTINCT FROM c.indicator_code OR t.kpi_code IS DISTINCT FROM c.kpi_code)
  `);
}
