export interface NeedRow {
  id: string;
  studyId: string;
  orgId: string;
  statement: string;
  village: string[];
  source: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Need {
  id: string;
  studyId: string;
  statement: string;
  village: string[];
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNeedPayload {
  statement: string;
  village: string[];
  source: string;
}

export interface UpdateNeedPayload {
  statement?: string;
  village?: string[];
  source?: string;
}
