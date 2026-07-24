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
  | 'report_sharing_request'
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

/** Filters shared by the list and CSV-export endpoints. */
export interface AuditQuery {
  organizationId?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  /** ISO-8601 instant; inclusive lower bound on `createdAt`. */
  dateFrom?: string;
  /** ISO-8601 instant; inclusive upper bound on `createdAt`. */
  dateTo?: string;
  /** Free text matched against the entity label and the actor's name/email. */
  search?: string;
}

/**
 * Paginated envelope for the audit list — same `{ items, total, limit,
 * offset }` shape studies uses. `total` is the count of rows matching the
 * filters *before* limit/offset, which is what the client needs to render
 * page counts once filtering moved server-side.
 */
export interface AuditListResult {
  items: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}
