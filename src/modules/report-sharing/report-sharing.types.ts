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
  expiresAt: Date | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
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
  /** RIO-FR-014 (client Q30) — null means access never expires on its own. */
  expiresAt: string | null;
  withdrawnBy: string | null;
  withdrawnAt: string | null;
}

export interface CreateReportSharingRequestPayload {
  ownerOrgId: string;
  reportId: string;
  /** "Purpose" in the UI — required (see report-sharing.contract.ts). */
  note: string;
}

export interface DecideReportSharingRequestPayload {
  note?: string;
  /** Only meaningful on approve — an optional expiry the owner sets at approval time (RIO-FR-014, Q30). */
  expiresAt?: string;
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
  // Approval-trail fields — included so the frontend can render this through
  // the exact same <ReportContentView> the owner's own Report Preview page
  // uses (see reports.types.ts's Report interface), instead of a separate,
  // visually-inconsistent renderer for shared reports.
  officerConfirmedBy: string | null;
  officerConfirmedByName: string | null;
  officerConfirmedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedByRole: string | null;
  reviewedAt: string | null;
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

/**
 * One row of the Report Catalog (client change 2026-10-05, bug 9): an
 * approved report another organization could request. Metadata only — the
 * content stays behind the existing request/approve flow.
 */
export interface ReportCatalogItem {
  reportId: string;
  title: string;
  reportType: string;
  generatedAt: string;
  /** When the report was approved and released — the catalog's
   * "publication date". Falls back to generatedAt for older rows. */
  publishedAt: string;
  ownerOrgId: string;
  ownerOrgName: string;
  /** The parent Study's Target Sector, when the report belongs to one. */
  sector: string | null;
  /** The parent Study's coverage, both languages (client clarification
   * 2026-10-05: region and governorate coverage on each catalog row). */
  regions: { name: string; nameAr: string | null }[];
  governorates: { name: string; nameAr: string | null }[];
  /** The caller's own most recent request for this report, if any. An
   * approved request past its expiry is reported as "expired". */
  myRequest: { id: string; status: SharingStatus; expiresAt: string | null } | null;
}
