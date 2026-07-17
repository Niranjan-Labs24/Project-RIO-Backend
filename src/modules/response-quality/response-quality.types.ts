export interface ResponseQualityResultRow {
  id: string;
  orgId: string;
  needId: string;
  studyId: string;
  // Null = computed across every Survey Link ("Consolidated"); set = scoped
  // to just that one link. See the schema.prisma model comment.
  surveyLinkId: string | null;
  surveyResponseId: string;
  completenessScore: number;
  missingFields: string[];
  confidenceFlag: "standard" | "low";
  isDuplicate: boolean;
  duplicateOfId: string | null;
  assessedAt: Date;
}

export interface ResponseQualityResult {
  id: string;
  needId: string;
  studyId: string;
  surveyLinkId: string | null;
  surveyResponseId: string;
  completenessScore: number;
  missingFields: string[];
  confidenceFlag: "standard" | "low";
  isDuplicate: boolean;
  duplicateOfId: string | null;
  assessedAt: string;
}

export interface AiSummaryRow {
  id: string;
  orgId: string;
  needId: string;
  studyId: string;
  surveyLinkId: string | null;
  summaryText: string;
  responseCount: number;
  generatedAt: Date;
}

export interface AiSummary {
  id: string;
  needId: string;
  studyId: string;
  surveyLinkId: string | null;
  summaryText: string;
  responseCount: number;
  generatedAt: string;
}
