export type NeedStatus =
  | 'draft'
  | 'evidence_submitted'
  | 'ai_classified'
  | 'reviewer_approved'
  | 'survey_created'
  | 'survey_published';

export interface NeedRow {
  id: string;
  studyId: string;
  orgId: string;
  title: string;
  statement: string;
  village: string[];
  source: string;
  referenceId: string | null;
  status: NeedStatus;
  domain: string | null;
  subDomain: string | null;
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
  source: string;
  referenceId: string | null;
  status: NeedStatus;
  domain: string | null;
  subDomain: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNeedPayload {
  title: string;
  statement: string;
  village: string[];
  source?: string;
  referenceId?: string;
}

export interface UpdateNeedPayload {
  title?: string;
  statement?: string;
  village?: string[];
  source?: string;
  referenceId?: string | null;
}

// A Need is editable only in `draft` — every later stage has produced
// downstream artifacts (evidence, an AI classification, a survey...) that
// an in-place edit would silently invalidate. `survey_published` is terminal:
// the Need is done.
export const NEED_EDITABLE_STATUSES: readonly NeedStatus[] = ['draft'];
