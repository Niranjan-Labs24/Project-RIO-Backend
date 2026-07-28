export type SharingStatus = "pending" | "approved" | "rejected" | "expired";

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
}

export interface DecideSharingRequestPayload {
  note?: string;
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
}

export interface SharedStudySnapshot {
  studyId: string;
  title: string;
  // A Study can hold many Needs — sharing the whole Study shares all of them.
  needs: SharedNeedSnapshot[];
  evidenceCount: number;
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
