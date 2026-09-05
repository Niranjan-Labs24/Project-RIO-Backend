// RIO-FR-009 — client Q17's five fixed analytical statuses, alongside Need's
// own existing workflow status (NeedStatus), not replacing it.
export type AnalyticalStatus =
  | 'observed'
  | 'under_analysis'
  | 'documented_in_study'
  | 'linked_to_initiative'
  | 'open_gap';

export const ANALYTICAL_STATUSES: AnalyticalStatus[] = [
  'observed',
  'under_analysis',
  'documented_in_study',
  'linked_to_initiative',
  'open_gap',
];

export interface InitiativeRow {
  id: string;
  orgId: string;
  name: string;
  domain: string | null;
  geography: string | null;
  startDate: Date | null;
  expectedEndDate: Date | null;
  status: string;
  fundingSource: string | null;
  description: string | null;
  budget: unknown; // Prisma.Decimal — converted to string in toInitiative()
  openToOtherEntities: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Initiative {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  domain: string | null;
  geography: string | null;
  startDate: string | null;
  expectedEndDate: string | null;
  status: string;
  fundingSource: string | null;
  description: string | null;
  budget: string | null;
  openToOtherEntities: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  linkedNeedCount: number;
}

export interface CreateInitiativePayload {
  name: string;
  domain?: string;
  geography?: string;
  startDate?: string;
  expectedEndDate?: string;
  status?: string;
  fundingSource?: string;
  description?: string;
  budget?: number;
  openToOtherEntities?: boolean;
}

export type UpdateInitiativePayload = Partial<CreateInitiativePayload>;

export interface NeedAnalyticalStatusEvent {
  id: string;
  fromStatus: AnalyticalStatus | null;
  toStatus: AnalyticalStatus;
  changedBy: string | null;
  changedAt: string;
  note: string | null;
}
