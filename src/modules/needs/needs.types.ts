export type NeedStatus =
  | 'draft'
  | 'evidence_submitted'
  | 'ai_classified'
  | 'reviewer_approved'
  | 'survey_created'
  | 'survey_published';

// RIO-FR-001: system-assigned only — see NeedsService.create /
// NeedsImportService, never accepted from the client (not in
// CreateNeedPayload/UpdateNeedPayload below).
export type NeedSource = 'manual_entry' | 'file_upload' | 'citizen_input' | 'field_survey';

export interface NeedRow {
  id: string;
  studyId: string;
  orgId: string;
  title: string;
  statement: string;
  village: string[];
  source: NeedSource;
  referenceId: string | null;
  status: NeedStatus;
  domain: string | null;
  subDomain: string | null;
  aiSuggestedDomain: string | null;
  aiSuggestedSubDomain: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Need {
  id: string;
  studyId: string;
  title: string;
  statement: string;
  village: string[];
  source: NeedSource;
  referenceId: string | null;
  status: NeedStatus;
  // Manual, authoritative Domain Category — set by the Researcher at
  // creation (mandatory on the manual-entry form), editable while still
  // `draft`. This is what reporting/scoring/downstream processing reads.
  domain: string | null;
  subDomain: string | null;
  // AI Classification's own suggestion, stored for transparency/future
  // reference only once a human reviews it — never the authoritative
  // value, never read downstream. See AiDecisionsService.review.
  aiSuggestedDomain: string | null;
  aiSuggestedSubDomain: string | null;
  createdBy: string;
  // Resolved display name for Entered By — null if the creating user has
  // since been removed (e.g. no self-org lookup for a deleted account).
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNeedPayload {
  title: string;
  statement: string;
  village: string[];
  domain: string;
  subDomain: string;
  referenceId?: string;
}

export interface UpdateNeedPayload {
  title?: string;
  statement?: string;
  village?: string[];
  domain?: string;
  subDomain?: string;
  referenceId?: string | null;
}

// A Need is editable only in `draft` — every later stage has produced
// downstream artifacts (evidence, an AI classification, a survey...) that
// an in-place edit would silently invalidate. `survey_published` is terminal:
// the Need is done.
export const NEED_EDITABLE_STATUSES: readonly NeedStatus[] = ['draft'];
