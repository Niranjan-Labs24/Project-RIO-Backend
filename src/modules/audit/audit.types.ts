export type AuditAction = 'create' | 'edit' | 'approve' | 'share' | 'delete' | 'login' | 'logout';
export type AuditEntityType = 'organization' | 'user' | 'study' | 'survey' | 'evidence' | 'report' | 'sharing_request';

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface RecordAuditInput {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  entityLabel: string;
  changes?: AuditChange[];
  metadata?: Record<string, unknown>;
}

export interface AuditActor {
  id: string;
  name: string;
  email: string;
}

// Matches the FE AuditEvent shape (see frontend-api-contract §3).
export interface AuditEvent {
  id: string;
  organizationId: string | null;
  actor: AuditActor | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  changes?: AuditChange[];
  metadata?: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}
