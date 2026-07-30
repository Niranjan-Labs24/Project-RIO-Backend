import type { EquityDetail, EquityDimension, Thresholds } from "../need-record.types";

export type { EquityDimension };

/** One segment's aggregate for a single indicator, e.g. gender=female → 62.50 (n=8). */
export interface SegmentRow {
  dimension: EquityDimension;
  value: string;
  severityScore: number | null;
  validResponseCount: number;
}

export interface EquityResult {
  equityFlag: boolean;
  equityDetail: EquityDetail;
}

const ALL_DIMENSIONS: readonly EquityDimension[] = ["gender", "settlement_type", "village"];

/**
 * Equity flag = variance across groups (the client's definition).
 *
 * Fires only when EVERY compared group in a dimension clears the minimum group
 * size — otherwise a single respondent could define a "group" and a 100-point
 * spread would be noise reported as inequity.
 *
 * When no dimension is evaluable, the flag is false AND equityDetail says the
 * sample was too small, naming the largest group found and which dimensions had
 * no data at all. A bare `false` would read as "we checked and found no
 * inequity", which is a different and much stronger claim.
 */
export function deriveEquityFlag(segments: SegmentRow[], t: Thresholds): EquityResult {
  const byDimension = new Map<EquityDimension, SegmentRow[]>();
  for (const s of segments) {
    if (s.severityScore === null) continue;
    const list = byDimension.get(s.dimension) ?? [];
    list.push(s);
    byDimension.set(s.dimension, list);
  }

  const evaluable: Array<{ dimension: EquityDimension; groups: SegmentRow[]; spread: number }> = [];
  const rejected: Array<{ dimension: EquityDimension; largestGroupN: number }> = [];

  for (const [dimension, groups] of byDimension) {
    // A single group is not a comparison.
    if (groups.length < 2) continue;
    const largestGroupN = Math.max(...groups.map((g) => g.validResponseCount));
    if (groups.some((g) => g.validResponseCount < t.equityMinGroupN)) {
      rejected.push({ dimension, largestGroupN });
      continue;
    }
    const scores = groups.map((g) => g.severityScore as number);
    evaluable.push({ dimension, groups, spread: Math.max(...scores) - Math.min(...scores) });
  }

  const dimensionsMissing = ALL_DIMENSIONS.filter((d) => !byDimension.has(d));

  if (evaluable.length === 0) {
    const largestGroupN = rejected.length ? Math.max(...rejected.map((r) => r.largestGroupN)) : 0;
    return {
      equityFlag: false,
      equityDetail: {
        evaluable: false,
        reason: `Largest comparison group has n=${largestGroupN}; minimum group size is ${t.equityMinGroupN}.`,
        dimensionsAvailable: rejected.map((r) => r.dimension),
        dimensionsMissing: [...dimensionsMissing],
      },
    };
  }

  // Report the widest dimension — that's the variance a reader must act on.
  const widest = evaluable.reduce((a, b) => (b.spread > a.spread ? b : a));
  const worst = widest.groups.reduce((a, b) =>
    (b.severityScore as number) > (a.severityScore as number) ? b : a,
  );

  return {
    equityFlag: widest.spread >= t.equitySpreadThreshold,
    equityDetail: {
      evaluable: true,
      reason: null,
      dimension: widest.dimension,
      groups: widest.groups.map((g) => ({
        label: g.value,
        severityScore: g.severityScore as number,
        n: g.validResponseCount,
      })),
      spread: Number(widest.spread.toFixed(2)),
      threshold: t.equitySpreadThreshold,
      mostDisadvantaged: worst.value,
      dimensionsAvailable: [...byDimension.keys()],
      dimensionsMissing: [...dimensionsMissing],
    },
  };
}
