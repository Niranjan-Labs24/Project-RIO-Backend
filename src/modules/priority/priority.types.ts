export interface PriorityScoreRow {
  id: string;
  orgId: string;
  needId: string;
  studyId: string;
  // Null = computed across every Survey Link ("Consolidated"); set = scoped
  // to just that one link. See the schema.prisma model comment.
  surveyLinkId: string | null;
  overallScore: number;
  level: "critical" | "high" | "medium" | "low";
  gapType: string;
  // See PriorityScore.equityFlagged's schema comment — persisted at scoring
  // time from PriorityService.score()'s equitySpread computation.
  equityFlagged: boolean;
  factors: unknown;
  // RIO-FR-003 AC 5 — the reviewer's own number, kept beside the computed one
  // rather than replacing it. Null until someone disagrees.
  overrideScore: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  cycleNote: string | null;
  scoredAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
}

export interface PriorityScore {
  id: string;
  needId: string;
  studyId: string;
  surveyLinkId: string | null;
  // The normalized 0-100 severity score (Σ(response value × indicator
  // weight), normalized against the max possible weighted score).
  overallScore: number;
  level: "critical" | "high" | "medium" | "low";
  gapType: string;
  // Explainable breakdown — one entry per indicator that fed this score,
  // so the frontend can show indicator/weight/response value/contribution
  // without recomputing anything.
  factors: Array<{ indicator: string; weight: number; responseValue: number; weightedContribution: number }>;
  cycleNote: string | null;
  /** What the engine computed. Never rewritten by an override. */
  computedScore: number;
  overrideScore: number | null;
  overrideReason: string | null;
  overriddenAt: string | null;
  /** What consumers should rank and display — the override when a reviewer
   *  set one, otherwise the computed value. Resolved server-side so every
   *  caller applies the same precedence. */
  effectiveScore: number;
  scoredAt: string;
  // Priority Scoring stays subject to reviewer approval — never publicly
  // visible (dashboard/reports) until approved. See PriorityService.approve.
  isApproved: boolean;
  approvedAt: string | null;
}

// Org-wide dashboard row — every Need, whether or not it's been scored yet
// (an unscored Need must still show up, just without a score).
//
// Backed by PriorityV2Service.listForOrg(), which fills `score` from one of
// two pipelines, in this order:
//   1. the Need's own APPROVED PriorityScore — per-need, reviewer-signed-off;
//   2. failing that, the village-priority rollup (VillagePriorityAssessment).
// They run in opposite directions, so `score.source` records which one it was.
export interface PriorityDashboardPage {
  items: PriorityDashboardEntry[];
  /** Rows matching the filters, across all pages. */
  total: number;
  limit: number;
  offset: number;
  /** Level counts over every need the caller can see, ignoring the filters. */
  summary: { critical: number; high: number; medium: number; low: number; unscored: number };
}

export interface PriorityDashboardEntry {
  studyId: string;
  studyTitle: string;
  needId: string;
  // RIO-FR-005 (Q12) — the Need's own analyst-entered Gap Type
  // classification. Was previously conflated with `score.gapType` below,
  // which was really always the critical-domain override reason string —
  // that field is now correctly named `overrideReason`.
  gapType: string | null;
  // RIO-FR-003 AC 6 — filter and group by theme without a second fetch.
  themes: string[];
  // RIO-FR-003 AC 1 — shown in the list so an unset urgency is visible as a
  // gap in the score rather than only on the need page.
  urgency: string | null;
  score: {
    overallScore: number;
    level: "critical" | "high" | "medium" | "low";
    overrideReason: string | null;
    scoredAt: string;
    // Which pipeline produced `overallScore`, and therefore which way the
    // number runs: `priorityScore` is a severity (high = urgent),
    // `villageRollup` a performance figure (low = urgent). Anything that
    // does arithmetic on the number rather than just showing it must read
    // this first — see ReportSummaryDataProvider's severity conversion.
    source: "priorityScore" | "villageRollup";
  } | null;
}

// RIO-FR-005 (Q9) — client-confirmed comparison metrics: "Priority Score,
// Needs Index, Critical/High Priority counts, Domain-wise severity, need
// type, and affected population."
/** One Domain's mean within a Centre. Same scale and direction as every
 *  other priority number here: 0-100, high = urgent. */
export interface CenterDomainBreakdown {
  domain: string;
  needCount: number;
  averageScore: number;
  level: 'critical' | 'high' | 'medium' | 'low';
  /** How many of this domain's `needCount` Needs are individually Critical
   *  / High — see `maskedCritical` below for why this is surfaced
   *  separately from the domain's own averaged `level`. */
  criticalNeedCount: number;
  highNeedCount: number;
  /** BRD Annex A's "no-masking rule" (Station 6a), carried down to Need
   *  granularity: true when this domain's averaged `level` reads calmer
   *  than Critical but at least one of its own Needs individually scores
   *  Critical — an outlier the average alone would hide. Always false when
   *  `level` is already 'critical' (nothing is hidden if the headline
   *  already shows the worst case). */
  maskedCritical: boolean;
}

// RIO-FR-005 — Heat Map side panel, per-KPI detail, per the product team's
// request (2026-09-21). One row per KPI scored under the clicked domain/village
// cell — see CenterAggregationService.kpiBreakdownForDomain for how each
// field is sourced (severity/confidence from ScoreRollup, analytical
// category from the Question Bank, gap type/equity flag inherited from the
// owning Need since neither is scored at KPI granularity anywhere).
export interface KpiSeverityEntry {
  domain: string;
  kpi: string;
  /** Arabic KPI name, from the Question Bank's own `kpiAr` column — null
   *  when that Question hasn't had an Arabic name entered yet. */
  kpiAr: string | null;
  severityScore: number | null;
  analyticalCategory: string | null;
  priorityTier: 'critical' | 'high' | 'medium' | 'low' | null;
  /** Analyst-entered on the Need's View Metrics screen: acute | chronic |
   *  structural | seasonal | equity. Null when the owning Need hasn't been
   *  classified yet. */
  gapType: string | null;
  /** GapTypeOption.nameAr for this value, resolved server-side (not left
   *  to the frontend to fetch — GET /study-config/gap-types is gated on
   *  methodologyQuestionBank:read, which most roles viewing this screen,
   *  e.g. ngo_admin, don't hold). Null when unset or no Arabic name has
   *  been entered for that option yet. */
  gapTypeAr: string | null;
  equityFlag: boolean;
  confidence: 'standard' | 'low';
  /** The engine's own Cycle-1 caveat (PriorityService's cycleNote), e.g.
   *  "Acute — Cycle 1, awaiting trend" — separate from the analyst's
   *  `gapType` above, not a replacement for it. */
  additionalGapTypeLabel: string | null;
}

/** Grouped by Centre rather than by `Need.village`: village is free text a
 *  researcher types with nothing validating it, while Centre is a real
 *  foreign key into the client's own geographic reference. Village names
 *  travel as labels in `villages`. See CenterAggregationService's comment for
 *  the full reasoning, including why the score is the mean of the Needs' own
 *  PriorityScores rather than a second separately-computed figure. */
export interface CenterComparisonEntry {
  centerId: string;
  /** Display value for a single-line caption — every Centre name joined,
   *  sorted, for a village-keyed entry (see CenterAggregationService's own
   *  header comment); the one Centre's own name otherwise. Client-reported
   *  (2026-09-24): the frontend must not just truncate this string with an
   *  ellipsis once it's a joined list — `centerNames` below is the same
   *  list un-joined, for a "first name +N more" treatment matching how
   *  `villages`/`studyIds` already render. */
  centerName: string;
  /** The individual Centre names `centerName` is joined from — always at
   *  least one entry except the (unplaced) sentinel. */
  centerNames: string[];
  centerNameAr: string | null;
  governorateName: string | null;
  governorateNameAr: string | null;
  regionName: string | null;
  regionNameAr: string | null;
  /** The village names the Needs at this Centre carry — display labels, not
   *  a grouping key. */
  villages: string[];
  studyIds: string[];
  /** Mean of this Centre's approved Need PriorityScores (override where the
   *  reviewer set one). Null until at least one Need here has an approved
   *  score. "Needs Index" in the client's wording is this figure. */
  priorityScore: number | null;
  priorityStatus: 'critical' | 'high' | 'medium' | 'low' | null;
  /** How many of `totalNeedCount` actually carried an approved score — the
   *  mean above is over these, so a place scored on 2 of 9 needs is not
   *  mistaken for one scored on all 9. */
  scoredNeedCount: number;
  domainBreakdown: CenterDomainBreakdown[];
  criticalNeedCount: number;
  highNeedCount: number;
  /** Need count grouped by its approved Domain — the closest existing
   * equivalent to "need type" in the confirmed metric list. */
  needTypeCounts: Record<string, number>;
  totalNeedCount: number;
  // RIO-FR-005 (Round 4, client-confirmed 2026-08-24) — sum of each Need's
  // manually entered Need.affectedPeople/affectedHouseholds at this Centre.
  // Null when none of them have either value entered yet, rather than a
  // fabricated 0 — see CenterAggregationService.aggregateByCenter.
  affectedPeople: number | null;
  affectedHouseholds: number | null;
}
