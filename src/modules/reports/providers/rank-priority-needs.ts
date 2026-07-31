import type { NeedRecord } from "../need-record.types";

export interface RankedNeed extends NeedRecord {
  rank: number;
  relevanceScore: number;
}

/** Printed in the report — the ranking must be reproducible by a reader. */
export const RANKING_BASIS =
  "severity × domain weight, tie-broken on severity, then valid-response count (desc), then indicator ID";

/**
 * Priority Needs ordering.
 *
 * Unmeasured needs are excluded from the ranking and returned separately: a null
 * severity has no rank, and giving it one (as the old `?? 0` did) placed it last
 * as though it were the mildest finding rather than the one nobody answered.
 */
export function rankPriorityNeeds(
  needs: NeedRecord[],
  domainWeightByKey: Map<string, number | null>,
): { ranked: RankedNeed[]; notMeasured: NeedRecord[] } {
  const notMeasured = needs.filter((n) => n.severityScore === null);

  const ranked = needs
    .filter((n): n is NeedRecord & { severityScore: number } => n.severityScore !== null)
    .map((n) => ({
      ...n,
      // A domain with no weight config falls back to 1 so the need still ranks
      // by raw severity rather than vanishing to a relevance of 0 — the exact
      // effect the missing Social Development / Governance weights had.
      relevanceScore: n.severityScore * (domainWeightByKey.get(n.domainKey) ?? 1),
    }))
    .sort(
      (a, b) =>
        b.relevanceScore - a.relevanceScore ||
        b.severityScore - a.severityScore ||
        b.validResponseCount - a.validResponseCount ||
        a.indicatorId.localeCompare(b.indicatorId),
    )
    .map((n, i) => ({ ...n, rank: i + 1, relevanceScore: Number(n.relevanceScore.toFixed(3)) }));

  return { ranked, notMeasured };
}
