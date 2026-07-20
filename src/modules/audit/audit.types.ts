export type AuditAction = 'create' | 'edit' | 'approve' | 'share' | 'delete' | 'login' | 'logout' | 'consent';
export type AuditEntityType =
  | 'organization'
  | 'user'
  | 'study'
  | 'need'
  | 'survey'
  | 'evidence'
  | 'ai_decision'
  | 'report'
  | 'sharing_request'
  | 'survey_response';

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
  // Explicit org to file this event under. Used by cross-org admin actions
  // (e.g. system_admin creating an org/user) so the event is traceable under
  // the AFFECTED org rather than the acting admin's own org. When omitted the
  // event is filed under the caller's ambient org context.
  organizationId?: string;
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
