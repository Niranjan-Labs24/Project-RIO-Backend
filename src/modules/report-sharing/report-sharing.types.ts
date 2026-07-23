import type { SharingStatus } from "../sharing/sharing.types";

export type { SharingStatus };

export interface ReportSharingRequestRow {
  id: string;
  ownerOrgId: string;
  requestingOrgId: string;
  reportId: string;
  status: SharingStatus;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  decisionNote: string | null;
}

export interface ReportSharingRequest {
  id: string;
  ownerOrgId: string;
  ownerOrgName: string;
  requestingOrgId: string;
  requestingOrgName: string;
  reportId: string;
  reportTitle: string;
  status: SharingStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  decisionNote: string | null;
}

export interface CreateReportSharingRequestPayload {
  ownerOrgId: string;
  reportId: string;
  /** "Purpose" in the UI — required (see report-sharing.contract.ts). */
  note: string;
}

export interface DecideReportSharingRequestPayload {
  note?: string;
}

// Read-only snapshot of the shared Report's own already-flattened content —
// no PDF/Excel bytes here, those are fetched separately via the existing
// (now cross-org-aware) GET /reports/:id/export.
export interface SharedReportSnapshot {
  reportId: string;
  title: string;
  reportType: string;
  content: Record<string, unknown>;
  generatedAt: string;
  ownerOrgName: string;
  generatedByName: string | null;
}

// Lookup rows for the "search organization → pick its approved report"
// create-request flow — deliberately name/title only.
export interface OrgLookupResult {
  id: string;
  name: string;
}

export interface ReportLookupResult {
  id: string;
  title: string;
}
