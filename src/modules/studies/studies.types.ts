export type StudyStatus = 'draft' | 'need_captured' | 'evidence_submitted' | 'ai_classified' | 'human_reviewed';

export interface StudyRow {
  id: string;
  orgId: string;
  title: string;
  domain: string | null;
  subDomain: string | null;
  villages: string[];
  status: StudyStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Study {
  id: string;
  title: string;
  // Set only once a human approves an AI Classification decision on this
  // Study's Need (see AiDecisionsService.review) — never directly editable
  // through Update Study.
  domain: string | null;
  subDomain: string | null;
  villages: string[];
  status: StudyStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudyPayload {
  title: string;
  villages?: string[];
}

export interface UpdateStudyPayload {
  title?: string;
  villages?: string[];
}

// RIO business rule: a researcher can delete a study up until
// it's been through AI Classification/Human Review — once classified or
// reviewed, it underpins a workflow other people rely on and can't be
// deleted out from under them.
export const DELETABLE_STUDY_STATUSES: readonly StudyStatus[] = [
  'draft',
  'need_captured',
  'evidence_submitted',
];

export interface ListStudiesQuery {
  limit?: number;
  offset?: number;
  status?: StudyStatus;
  village?: string;
  search?: string;
}

export interface StudyListResult {
  items: Study[];
  total: number;
  limit: number;
  offset: number;
}

export interface StudyDetail extends Study {
  evidenceCount: number;
}
