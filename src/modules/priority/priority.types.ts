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
  factors: unknown;
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
  scoredAt: string;
  // Priority Scoring stays subject to reviewer approval — never publicly
  // visible (dashboard/reports) until approved. See PriorityService.approve.
  isApproved: boolean;
  approvedAt: string | null;
}

// Org-wide dashboard row — every Need, whether or not it's been scored yet
// (a Need with no VillagePriorityAssessment must still show up, just
// unscored). Backed by PriorityV2Service.listForOrg() (the real,
// methodology-driven village-priority pipeline) — not the older
// PriorityService/PriorityScore placeholder, which no UI writes to anymore.
export interface PriorityDashboardEntry {
  studyId: string;
  studyTitle: string;
  needId: string;
  // RIO-FR-005 (Q12) — the Need's own analyst-entered Gap Type
  // classification. Was previously conflated with `score.gapType` below,
  // which was really always the critical-domain override reason string —
  // that field is now correctly named `overrideReason`.
  gapType: string | null;
  score: {
    overallScore: number;
    level: "critical" | "high" | "medium" | "low";
    overrideReason: string | null;
    scoredAt: string;
  } | null;
}

// RIO-FR-005 (Q9) — client-confirmed comparison metrics: "Priority Score,
// Needs Index, Critical/High Priority counts, Domain-wise severity, need
// type, and affected population."
export interface VillageComparisonEntry {
  village: string;
  studyIds: string[];
  /** Latest VillagePriorityAssessment for this village across the given
   * studies — null if none has been calculated yet (e.g. no survey
   * published/scored for that village). "Needs Index" in the client's own
   * wording is this same figure — the methodology has one aggregate
   * per-village score, not two separate ones. */
  priorityScore: number | null;
  priorityStatus: string | null;
  domainComponents: unknown | null;
  criticalNeedCount: number;
  highNeedCount: number;
  /** Need count grouped by its approved Domain — the closest existing
   * equivalent to "need type" in the confirmed metric list. */
  needTypeCounts: Record<string, number>;
  totalNeedCount: number;
  // RIO-FR-005 (Round 4, client-confirmed 2026-08-24) — sum of each Need's
  // manually entered Need.affectedPeople/affectedHouseholds for this
  // village. Null when none of the village's Needs have either value
  // entered yet, rather than a fabricated 0 — see
  // VillageAggregationService.aggregateByVillage.
  affectedPeople: number | null;
  affectedHouseholds: number | null;
}
