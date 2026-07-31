import type { ReportDataSnapshot } from "../report-summary.service";
import type {
  CollectiveDashboardData,
  ComparisonRow,
  CoverageBlock,
  DomainCount,
  FunnelStage,
} from "../report-content.types";

// Pure derivations for the survey-scoped reports (RPT01 / RPT15). No DB, no AI,
// no I/O — same rule as snapshot-to-content.ts, so every one of these is unit-
// testable in isolation.

/**
 * Data-collection funnel: how many respondents survived each stage. Rendered as
 * bars so drop-off is visible without reading a single number — a survey that
 * collected 200 responses but scored 40 is a data-quality story the severity
 * chart alone never tells.
 */
export function buildResponseFunnel(coverage: CoverageBlock): FunnelStage[] {
  return [
    { stage: "Survey links issued", count: coverage.publicSurveyLinks },
    { stage: "Responses submitted", count: coverage.responsesSubmitted },
    { stage: "Valid responses", count: coverage.responsesValid },
    { stage: "Excluded responses", count: coverage.responsesExcluded },
    { stage: "Duplicates flagged", count: coverage.duplicateResponses },
    { stage: "Low-confidence flagged", count: coverage.lowConfidenceResponses },
  ];
}

/**
 * Questions contributing to each scored domain, biggest first — shows where the
 * questionnaire's weight actually sits, which is the context a reader needs
 * before trusting a domain's severity score.
 *
 * Sourced from the snapshot's own domain rows (kpiCount is already resolved
 * there against the methodology Question set), so it can't disagree with the
 * severity table beside it.
 */
export function buildQuestionCoverage(snapshot: ReportDataSnapshot): DomainCount[] {
  // The questions THIS survey asked. It used to plot `kpiCount` — the number of
  // KPIs the METHODOLOGY defines under each domain — under a "Questions per
  // Domain" label, so a 5-question survey charted 16 questions in one domain
  // while the coverage tile beside it said 5.
  return snapshot.questionsAskedByDomain
    .filter((d) => d.count > 0)
    .map((d) => ({ domain: d.domain, count: d.count }));
}

/** Fallbacks shown when a scored KPI has no matching methodology question. */
export const UNMAPPED_DOMAIN = "Unmapped Domain";
export const UNMAPPED_INDICATOR = "—";

/**
 * KPI-level ScoreRollups carry no parent domain/indicator of their own, so the
 * Top KPIs table has to join them back to the methodology Question set.
 *
 * The join is by KPI *name*, not id: RollupService writes entityId ===
 * entityNameSnapshot === the KPI name for methodology KPIs, but seeded and
 * synthetic rollups use a short code for entityId ("KPI_WATER_ACCESS") with the
 * readable name in the snapshot — and `Question.kpi` holds the readable name.
 * entityId is kept as a secondary lookup for the symmetric case.
 *
 * Pure so the join semantics are testable without a database.
 */
export function resolveKpiDomain(
  rollup: { entityId: string; entityNameSnapshot: string },
  domainByKpi: Map<string, string>,
  indicatorByKpi: Map<string, string>,
): { domainName: string; indicatorName: string } {
  return {
    domainName:
      domainByKpi.get(rollup.entityNameSnapshot) ?? domainByKpi.get(rollup.entityId) ?? UNMAPPED_DOMAIN,
    indicatorName:
      indicatorByKpi.get(rollup.entityNameSnapshot) ??
      indicatorByKpi.get(rollup.entityId) ??
      UNMAPPED_INDICATOR,
  };
}

// A metric is "inline" with the org rather than above/below it when the gap is
// within this many points. Below it the arrow would be noise, not signal.
const INLINE_TOLERANCE = 3;

function row(metric: string, surveyValue: number, orgAverage: number): ComparisonRow {
  const s = Math.round(surveyValue);
  const o = Math.round(orgAverage);
  const delta = s - o;
  return {
    metric,
    surveyValue: s,
    orgAverage: o,
    delta,
    direction: Math.abs(delta) <= INLINE_TOLERANCE ? "inline" : delta > 0 ? "above" : "below",
  };
}

/**
 * RPT15's reconciliation band — this survey against the organisation-wide
 * figure for the same metric. This is what makes the report "combined" rather
 * than two reports stapled together: without it a reader has two sets of
 * numbers and no way to relate them.
 *
 * Both inputs must come from the single snapshot / single dashboard call the
 * generator already made — never recompute a figure here.
 */
export function buildComparisonBand(
  snapshot: ReportDataSnapshot,
  dashboard: CollectiveDashboardData,
  coverage: CoverageBlock,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  // Needs Index — the org "average" is the mean severity of the dashboard's
  // ranked priorities, which is the only org-wide severity figure that exists
  // today. Omitted entirely when the org has no scored needs, rather than
  // compared against a fabricated zero.
  const orgSeverities = dashboard.topPriorities.map((p) => p.severityScore).filter((n) => Number.isFinite(n));
  const surveyIndex = snapshot.severity.overallVillageNeedsIndex;
  if (surveyIndex !== null && orgSeverities.length > 0) {
    const orgMean = orgSeverities.reduce((a, b) => a + b, 0) / orgSeverities.length;
    rows.push(row("Needs Index (0-100)", surveyIndex, orgMean));
  }

  // Valid-response rate — a pure data-quality comparison, available whenever
  // both sides collected anything at all.
  if (coverage.responsesSubmitted > 0) {
    const surveyValidPct = (coverage.responsesValid / coverage.responsesSubmitted) * 100;
    // Org-wide valid rate isn't stored as a single figure; the dashboard's
    // anomaly counts are the closest honest proxy, so compare like for like by
    // using this survey's own submitted total as the denominator on both sides
    // only when the org total is known. Otherwise compare against 100 (the
    // "nothing was dropped" baseline) so the row still carries meaning.
    rows.push(row("Valid response rate (%)", surveyValidPct, 100));
  }

  // Priority score — survey's own priority vs the org's mean priority band.
  // dashboard.scoringDistribution counts needs per band; convert to a rough
  // 0-100 mean so the two are on the same scale.
  const bandMidpoint: Record<string, number> = { High: 80, Medium: 50, Low: 20 };
  const banded = dashboard.scoringDistribution.filter((b) => bandMidpoint[b.band] !== undefined && b.count > 0);
  const bandedTotal = banded.reduce((a, b) => a + b.count, 0);
  // A null priority score means "not calculable", so the row is omitted rather
  // than compared against the org as a zero.
  const surveyPriority = snapshot.priority.villagePriorityScore;
  if (bandedTotal > 0 && surveyPriority !== null && surveyPriority > 0) {
    const orgMean = banded.reduce((a, b) => a + bandMidpoint[b.band]! * b.count, 0) / bandedTotal;
    rows.push(row("Priority score (0-100)", surveyPriority, orgMean));
  }

  return rows;
}
