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
  studyType: string | null;
  targetSector: string | null;
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
  studyType: string | null;
  targetSector: string | null;
  orgName?: string;
  // RIO-RBAC-002 (client-confirmed, 2026-08-27 round) — System Admin is
  // platform-wide, so acting on a Study it's viewing (e.g. adding a Need)
  // needs to know which org to send as X-Act-As-Org; Study never exposed
  // this before since a non-crossEntity caller only ever sees their own
  // org's Studies anyway, making it redundant for them. Always present —
  // harmless for those callers, load-bearing for crossEntity ones.
  orgId: string;
  surveysCount?: number;
}

export interface CreateStudyPayload {
  title: string;
  villages?: string[];
  governorateIds: string[];
  centerIds: string[];
  // Mandatory: a Study must bind to a specific (published) methodology
  // version at creation — see StudiesService.create.
  methodologyVersionId: string;
  population: number;
  marginOfError?: number;
  // RIO-FR-012 (Q3/Q4) — validated against StudyTypeOption/TargetSectorOption's
  // active names at the API layer, not an FK (see study-config.service.ts).
  studyType?: string;
  targetSector?: string;
}

export interface UpdateStudyPayload {
  title?: string;
  villages?: string[];
  governorateIds?: string[];
  centerIds?: string[];
  // Optional to omit on a PATCH (leaves the existing binding untouched),
  // but never nullable — once set at creation, a Study can no longer be
  // left without a methodology version.
  methodologyVersionId?: string;
  studyType?: string;
  targetSector?: string;
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
