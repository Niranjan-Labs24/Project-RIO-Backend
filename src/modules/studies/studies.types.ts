export interface StudyRow {
  id: string;
  orgId: string;
  title: string;
  villages: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// A Study is a pure container — no status/domain/subDomain of its own.
// Each Need under it runs its own independent lifecycle (see
// needs/needs.types.ts's NeedStatus) — a Study stays open for new Needs
// regardless of how far along its existing ones are.
export interface Study {
  id: string;
  title: string;
  villages: string[];
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

export interface ListStudiesQuery {
  limit?: number;
  offset?: number;
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
  needCount: number;
}
