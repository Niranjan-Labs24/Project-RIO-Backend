export type StudyStatus = 'draft' | 'need_captured' | 'evidence_submitted' | 'ai_classified' | 'human_reviewed';

export interface StudyRow {
  id: string;
  orgId: string;
  title: string;
  villages: string[];
  status: StudyStatus;
  assignedReviewerId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Study {
  id: string;
  title: string;
  villages: string[];
  status: StudyStatus;
  assignedReviewerId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudyPayload {
  title: string;
  villages?: string[];
  // Required unless the org has no active NGO Research Officer at all —
  // enforced in StudiesService.resolveAssignedReviewer, not the TypeBox
  // contract, since "is one required" depends on live org data.
  assignedReviewerId?: string;
}

export interface UpdateStudyPayload {
  title?: string;
  villages?: string[];
}

// Study-create's reviewer picker — deliberately just id/name/email, not the
// full OrgUser shape (no role/status/createdAt): a Research Officer who can
// create a Study but lacks entityTeam:read must still be able to see this
// list, so it's exposed via studies (studySurvey:create), not users
// (entityTeam:read).
export interface AssignableReviewer {
  id: string;
  name: string;
  email: string;
}

// RIO business rule (per Ganesh): a researcher can delete a study up until
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
