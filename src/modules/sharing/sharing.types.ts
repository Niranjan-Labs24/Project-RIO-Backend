export type SharingStatus = "pending" | "approved" | "rejected" | "expired" | "withdrawn";

export interface SharingRequestRow {
  id: string;
  ownerOrgId: string;
  requestingOrgId: string;
  studyId: string;
  status: SharingStatus;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  // Optional reason the owner gives when approving/rejecting — was
  // previously missing entirely on this module (reject was a single click,
  // no explanation). Same field shape as ReportSharingRequest.
  decisionNote: string | null;
  expiresAt: Date | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
}

export interface SharingRequest {
  id: string;
  ownerOrgId: string;
  ownerOrgName: string;
  requestingOrgId: string;
  requestingOrgName: string;
  studyId: string;
  studyTitle: string;
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

export interface DecideSharingRequestPayload {
  note?: string;
  /** Only meaningful on approve — an optional expiry the owner sets at approval time (RIO-FR-014, Q30). */
  expiresAt?: string;
}

export interface CreateSharingRequestPayload {
  ownerOrgId: string;
  studyId: string;
  /** "Purpose" in the UI — required (see sharing.contract.ts). */
  note: string;
}

export interface SharedNeedSnapshot {
  id: string;
  statement: string;
  village: string[];
  status: string;
  // UAT SHR-04 — the full read-only study view.
  internalReferenceId: string;
  title: string;
  domain: string | null;
  subDomain: string | null;
  affectedPopulation: number | null;
}

/** UAT SHR-04 — an evidence file's description; the file itself is not shared. */
export interface SharedEvidenceSnapshot {
  id: string;
  title: string | null;
  fileName: string;
  fileType: string;
  needId: string;
  uploadedAt: string;
}

/** UAT SHR-04 — a released report of the shared study, viewable read-only. */
export interface SharedStudyReportSummary {
  id: string;
  title: string;
  reportType: string;
  generatedAt: string;
}

export interface SharedStudySnapshot {
  studyId: string;
  title: string;
  // A Study can hold many Needs — sharing the whole Study shares all of them.
  needs: SharedNeedSnapshot[];
  evidenceCount: number;
  // UAT SHR-04 — "View full study": the study's own details, its evidence
  // list and its released reports, all read-only.
  ownerOrgName: string;
  studyType: string | null;
  targetSector: string | null;
  population: number | null;
  requiredSampleSize: number | null;
  createdAt: string;
  governorates: { name: string; nameAr: string | null }[];
  evidence: SharedEvidenceSnapshot[];
  reports: SharedStudyReportSummary[];
}

// Lookup rows for the "search organization → pick its completed study"
// create-request flow — deliberately name/title only, no other org's
// internal data leaks through here.
export interface OrgLookupResult {
  id: string;
  name: string;
}

export interface StudyLookupResult {
  id: string;
  title: string;
}
