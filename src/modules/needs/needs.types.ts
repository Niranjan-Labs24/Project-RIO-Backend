export interface NeedRow {
  id: string;
  studyId: string;
  orgId: string;
  title: string;
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
  title: string;
  statement: string;
  village: string[];
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNeedPayload {
  title: string;
  statement: string;
  village: string[];
}

export interface UpdateNeedPayload {
  title?: string;
  statement?: string;
  village?: string[];
}
