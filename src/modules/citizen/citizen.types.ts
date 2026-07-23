export interface PublicSurveyLinkRow {
  id: string;
  orgId: string;
  needId: string;
  studyId: string;
  token: string;
  createdBy: string;
  expiresAt: Date | null;
  isActive: boolean;
  createdAt: Date;
}

export interface CitizenOtpChallengeRow {
  id: string;
  orgId: string;
  surveyLinkId: string;
  contact: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface ResolvedSurvey {
  studyId: string;
  title: string;
  version: string;
  // Real Study/Organisation context (distinct from `title`, which is the
  // placeholder Survey Definition's own generic title) — shown on the
  // citizen flow's "Study Information" step so respondents know what
  // they're actually responding to before answering questions.
  studyTitle: string;
  organizationName: string;
  questions: Array<{ code: string; text: string; type: string; options?: string[]; required: boolean }>;
  // Derived from `questions.length` server-side so the Welcome screen never
  // has to duplicate that arithmetic (or a hardcoded seconds-per-question
  // constant) on the frontend.
  questionCount: number;
  estimatedMinutes: number;
}

export interface CheckDuplicatePayload {
  contact: string;
}

export interface CheckDuplicateResult {
  isDuplicate: boolean;
}

export interface RequestOtpPayload {
  contact: string;
}

export interface RequestOtpResult {
  challengeId: string;
  expiresAt: string;
  codeEmailed: boolean;
  /** Only present when `codeEmailed` is false and the mailer isn't
   * configured (dev/test) — mirrors the temp-password reveal convention in
   * UsersService.invite/AuthService.signup, since there's otherwise no way
   * for the respondent to get the code at all. */
  code?: string;
}

export interface VerifyOtpPayload {
  challengeId: string;
  code: string;
}

export interface VerifyOtpResult {
  verified: true;
}

export type Gender = 'male' | 'female' | 'other' | 'prefer_not_to_say';

export interface SubmitResponsePayload {
  challengeId: string;
  contactName?: string;
  gender?: Gender;
  answers: Record<string, unknown>;
}

export interface SubmitResponseResult {
  id: string;
  submittedAt: string;
}
