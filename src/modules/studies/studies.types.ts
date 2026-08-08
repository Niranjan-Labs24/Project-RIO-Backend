export interface StudyRow {
  id: string;
  orgId: string;
  title: string;
  villages: string[];
  governorateIds: string[];
  centerIds: string[];
  methodologyVersionId: string | null;
  // RIO-FR-024: computed and stored once, at creation — see
  // StudiesService.create/sample-size.ts. Null for studies created before
  // this feature shipped.
  population: number | null;
  marginOfError: number | null;
  requiredSampleSize: number | null;
  minimumDetectableEffect: number | null;
  cycleNumber: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// A Study is a pure container — no status/domain/subDomain of its own.
// Each Need under it runs its own independent lifecycle (see
// needs/needs.types.ts's NeedStatus) — a Study stays open for new Needs
// regardless of how far along its existing ones are.
export interface StudyAssociatedNeed {
  id: string;
  title: string;
  status: string;
  village: string;
  domainCategory: string;
  createdAt: string;
  responseCount: number;
  questionCount: number;
  score: number | null;
  evidenceCount: number;
}

export interface Study {
  id: string;
  title: string;
  villages: string[];
  governorateIds: string[];
  centerIds: string[];
  methodologyVersionId: string | null;
  population: number | null;
  marginOfError: number | null;
  requiredSampleSize: number | null;
  minimumDetectableEffect: number | null;
  cycleNumber: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  orgName?: string;
  surveysCount?: number;
}

export interface CreateStudyPayload {
  title: string;
  villages?: string[];
  governorateIds: string[];
  centerIds: string[];
  methodologyVersionId?: string | null;
  population: number;
  marginOfError?: number;
}

export interface UpdateStudyPayload {
  title?: string;
  villages?: string[];
  governorateIds?: string[];
  centerIds?: string[];
  methodologyVersionId?: string | null;
}

export interface ListStudiesQuery {
  organizationId?: string;
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
  needs?: StudyAssociatedNeed[];
}
