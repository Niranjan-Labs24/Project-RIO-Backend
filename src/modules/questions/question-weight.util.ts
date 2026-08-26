/**
 * RIO-AI-002 / RIO-FR-012 (Q32, client-confirmed 2026-08-20) — question
 * weight is not an independently configured value. It is auto-computed by
 * even distribution at every level of the methodology tree, scoped
 * per-domain (each domain is its own 100% pool, not a share of a global
 * 100% across every domain — domain-vs-domain importance is a separate,
 * pre-existing mechanism, `PriorityFactorWeights`, and this must not
 * duplicate it):
 *
 *   Domain (100%)
 *     -> Sub-domain (100% / sub-domain count under this domain)
 *       -> Indicator (parent / indicator count under this sub-domain)
 *         -> KPI (parent / KPI count under this indicator)
 *           -> Question (parent / question count under this KPI)
 *
 * Purely a function of the question set passed in — no DB access, so it
 * can be computed once per methodology version and reused, and unit-tested
 * without a database. Nullable indicator/kpi group under a fallback key
 * ('') rather than throwing, since a question bank entry is not guaranteed
 * to carry every level.
 */

export interface WeightableQuestion {
  id: string;
  domain: string;
  subDomain: string;
  indicator: string | null;
  kpi: string | null;
}

/** Map-of-maps get-or-create helper — avoids joined-string keys, which can
 * collide across different tuples whose parts happen to concatenate to the
 * same characters (e.g. "Water Sanitation"+"Household Access" vs.
 * "Water"+"Sanitation Household Access"). Nesting by exact string identity
 * at each level is collision-proof regardless of content. */
function getOrCreate<K, V>(map: Map<K, V>, k: K, create: () => V): V {
  let v = map.get(k);
  if (v === undefined) {
    v = create();
    map.set(k, v);
  }
  return v;
}

/** Returns a Map of question row id -> weight (a fraction of 1.0, i.e. of its own domain's 100%). */
export function computeQuestionWeights(
  questions: readonly WeightableQuestion[],
): Map<string, number> {
  const weights = new Map<string, number>();
  const norm = (v: string | null) => v ?? '';

  // domain -> subDomain -> indicator -> kpi -> questions
  const tree = new Map<
    string,
    Map<string, Map<string, Map<string, WeightableQuestion[]>>>
  >();

  for (const q of questions) {
    const indicator = norm(q.indicator);
    const kpi = norm(q.kpi);

    const subDomains = getOrCreate(tree, q.domain, () => new Map());
    const indicators = getOrCreate(subDomains, q.subDomain, () => new Map());
    const kpis = getOrCreate(indicators, indicator, () => new Map());
    const bucket = getOrCreate(kpis, kpi, () => [] as WeightableQuestion[]);
    bucket.push(q);
  }

  for (const subDomains of tree.values()) {
    const subDomainCount = subDomains.size;
    for (const indicators of subDomains.values()) {
      const indicatorCount = indicators.size;
      for (const kpis of indicators.values()) {
        const kpiCount = kpis.size;
        for (const siblingQuestions of kpis.values()) {
          const weight = 1 / (subDomainCount * indicatorCount * kpiCount * siblingQuestions.length);
          for (const q of siblingQuestions) {
            weights.set(q.id, weight);
          }
        }
      }
    }
  }

  return weights;
}
