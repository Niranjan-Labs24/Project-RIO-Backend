export interface PublicSurveyLinkRow {
  id: string;
  orgId: string;
  needId: string;
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
  needId: string;
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

/** One row in the Survey Responses list — Name/Email/Submitted Date, the
 * fields the list view actually shows; full answers only load on demand
 * (see SurveyResponseDetail) since a list of 100+ responses shouldn't ship
 * every answer body up front. */
export interface SurveyResponseSummary {
  id: string;
  needId: string;
  surveyLinkId: string;
  contactName: string | null;
  contact: string;
  submittedAt: string;
}

/** One answered question, enriched with the question's own text/type so the
 * "View Response" UI never has to cross-reference the survey separately —
 * `answers` on the raw SurveyResponse row is keyed by SurveyQuestion id,
 * meaningless without this join. */
export interface SurveyResponseAnswer {
  questionId: string;
  questionText: string;
  answerType: string;
  answer: string | null;
}

export interface SurveyResponseDetail extends SurveyResponseSummary {
  answers: SurveyResponseAnswer[];
}
