export type AuditAction =
  | 'create'
  | 'edit'
  | 'approve'
  | 'share'
  | 'delete'
  | 'login'
  | 'logout'
  | 'consent'
  | 'ORGANIZATION_CREATED'
  | 'ORGANIZATION_APPROVED'
  | 'ORGANIZATION_DEACTIVATED'
  | 'ORGANIZATION_REACTIVATED'
  | 'SYSTEM_ADMIN_VIEWED_ORGANIZATION'
  | 'NGO_ADMIN_ASSIGNED'
  | 'NGO_ADMIN_CHANGED'
  | 'NGO_ADMIN_ROLE_REMOVED'
  | 'SYSTEM_ADMIN_VIEWED_ORGANIZATION_USERS'
  | 'USER_INVITED_BY_SYSTEM_ADMIN'
  | 'USER_ROLE_CHANGED_BY_SYSTEM_ADMIN'
  | 'USER_DISABLED_BY_SYSTEM_ADMIN'
  | 'USER_ENABLED_BY_SYSTEM_ADMIN'
  | 'USER_INVITATION_RESENT'
  | 'SYSTEM_ADMIN_VIEWED_STUDIES'
  | 'SYSTEM_ADMIN_VIEWED_SURVEY'
  | 'SYSTEM_ADMIN_VIEWED_REPORT'
  | 'SYSTEM_ADMIN_DOWNLOADED_REPORT'
  | 'STUDY_ARCHIVED'
  | 'STUDY_RESTORED'
  | 'SYSTEM_ADMIN_VIEWED_ARCHIVE'
  | 'SYSTEM_ADMIN_VIEWED_ARCHIVED_REPORT'
  | 'upload_evidence_document'
  | 'download_evidence_document'
  | 'delete_evidence_document'
  | 'generate_document_summary'
  | 'confirm_document_summary'
  | 'generate_combined_summary'
  | 'confirm_combined_summary'
  | 'export';
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
  | 'survey_response'
  | 'evidence_document'
  | 'evidence_document_summary'
  | 'combined_report_summary'
  | 'ncnp_report'
  | 'question';

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
  // The submitter's own external tracking id for the entity this event is
  // about (e.g. Need.referenceId) — a first-class, indexed column, not
  // another metadata key. Omit (or null) when the entity has no such
  // reference.
  sourceRef?: string | null;
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
  sourceRef: string | null;
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
  /** Exact match against the entity's own external tracking id (e.g. a
   * Need's reference_id) — the reason this column is indexed. */
  sourceRef?: string;
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
