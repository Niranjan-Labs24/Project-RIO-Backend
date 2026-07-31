export type NcnpReportReviewStatus = 'draft' | 'approved' | 'rejected' | 'released';

export interface NcnpReportReviewRow {
  id: string;
  status: NcnpReportReviewStatus;
  content: unknown;
  filters: unknown;
  generatedBy: string;
  generatedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewerNotes: string | null;
  publishedBy: string | null;
  publishedAt: Date | null;
}

export interface NcnpReportReviewSummary {
  id: string;
  status: NcnpReportReviewStatus;
  filters: Record<string, unknown>;
  generatedBy: string;
  generatedByName: string | null;
  generatedAt: string;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewerNotes: string | null;
  publishedBy: string | null;
  publishedByName: string | null;
  publishedAt: string | null;
}

// The detail view additionally carries the frozen report snapshot itself.
export interface NcnpReportReviewDetail extends NcnpReportReviewSummary {
  content: Record<string, unknown>;
}
