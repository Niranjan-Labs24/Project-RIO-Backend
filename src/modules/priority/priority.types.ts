export interface PriorityScoreRow {
  id: string;
  orgId: string;
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
}

export interface PriorityScore {
  id: string;
  studyId: string;
  surveyLinkId: string | null;
  overallScore: number;
  level: "critical" | "high" | "medium" | "low";
  gapType: string;
  factors: Array<{ key: string; label: string; value: number; weight: number }>;
  cycleNote: string | null;
  scoredAt: string;
  isPlaceholder: true;
}

// Org-wide dashboard row — every study, whether or not it's been scored yet
// (a study with no PriorityScore row must still show up, just unscored —
// see the fixed listForOrg()).
export interface PriorityDashboardEntry {
  studyId: string;
  studyTitle: string;
  studyStatus: string;
  score: PriorityScore | null;
}
