export interface StudyRow {
  id: string;
  orgId: string;
  title: string;
  villages: string[];
  governorateIds: string[];
  centerIds: string[];
  methodologyVersionId: string | null;
  cycleNumber: number;
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
  // Mandatory multi-select subsets of the owning Organization's own
  // selected Governorates/Centers (checked in StudiesService, not
  // enforceable by the join tables' FKs alone). No Region field here — it's
  // derived live from the owning Organization's own single regionId.
  governorateIds: string[];
  centerIds: string[];
  // Optional link into the real, status-gated MethodologyVersion master
  // data (see priority module) — must be PUBLISHED when set (checked in
  // StudiesService), settable at creation or later.
  methodologyVersionId: string | null;
  // Sequential per-org counter (1, 2, 3... across every Study the org has
  // ever created) — server-assigned at creation, never client-writable.
  cycleNumber: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudyPayload {
  title: string;
  villages?: string[];
  governorateIds: string[];
  centerIds: string[];
  methodologyVersionId?: string | null;
}

export interface UpdateStudyPayload {
  title?: string;
  villages?: string[];
  governorateIds?: string[];
  centerIds?: string[];
  methodologyVersionId?: string | null;
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
