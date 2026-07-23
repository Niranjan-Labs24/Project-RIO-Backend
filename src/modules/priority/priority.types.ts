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
  score: {
    overallScore: number;
    level: "critical" | "high" | "medium" | "low";
    gapType: string | null;
    scoredAt: string;
  } | null;
}
