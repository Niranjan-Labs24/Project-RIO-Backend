export interface PublicSurveyLinkRow {
  id: string;
  orgId: string;
  studyId: string;
  label: string;
  token: string;
  createdBy: string;
  expiresAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  responseCount: number;
}

export interface PublicSurveyLink {
  id: string;
  studyId: string;
  // User-facing name — the only identifier the UI ever shows for a link;
  // never the token/id (see the plan's "no technical identifiers" note).
  label: string;
  token: string;
  // The plain public URL the frontend renders as a QR code client-side —
  // no server-generated image, see the plan's "Publish Survey + QR" note.
  publicUrl: string;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  responseCount: number;
}

export interface CreateSurveyLinkPayload {
  label: string;
  expiresInDays?: number;
}
