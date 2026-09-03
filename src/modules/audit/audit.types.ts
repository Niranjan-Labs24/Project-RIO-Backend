export type AuditAction =
  | 'create'
  | 'edit'
  | 'approve'
  | 'reject'
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
  // RIO-AI-003 — need statement summarisation. Deliberately distinct from the
  // document/combined summary actions above: those summarise an uploaded
  // document or a whole report, while these shorten the description of one
  // Need. An auditor filtering for who signed off the wording that reached a
  // report must not have the three collapsed together.
  //
  // NOTE: keep apostrophes out of comments inside this union. The frontend
  // contract test (audit-action-labels.test.ts) extracts the members with a
  // single-quoted-string regex, so a stray apostrophe in a comment silently
  // shifts every quote pair after it and the two lists appear to have drifted.
  | 'generate_need_summary'
  | 'edit_need_summary'
  | 'confirm_need_summary'
  // RIO-FR-003. Theme extraction rewrites what a need is filed under and feeds
  // the recurrence factor, so a change here moves priority rankings.
  | 'extract_need_themes'
  | 'override_priority_score'
  // RIO-FR-002 AC 4 — "reviewer decision is logged". Two actions, not one:
  // review_cleaning_flag records the DECISION (accept or reject, with the
  // reviewer note), apply_standardization records that a value was actually
  // WRITTEN onto a record as a result. A rejection produces the first and not
  // the second, and an auditor asking "what changed the data" must be able to
  // filter to the writes.
  | 'review_cleaning_flag'
  | 'apply_standardization'
  // RIO-FR-002 AC 3/AC 4 and RIO-AI-004. A decision on a PROPOSED PAIR, which
  // is a different thing from a decision on a field-level finding: this one
  // says two records are or are not the same need. It never merges them —
  // the merge belongs to AI-004 and will carry its own action.
  // NOTE for anyone adding a member below: comments inside this union may
  // contain NEITHER an apostrophe NOR a semicolon. The frontend contract test
  // (audit-action-labels.test.ts) reads this union out of the source with a
  // non-greedy match that stops at the FIRST semicolon, then pairs single
  // quotes to pull out the members. So a stray apostrophe shifts every quote
  // pair after it, and a stray semicolon truncates the union there and
  // silently drops every member below.
  //
  // Both failure modes surface as "the frontend has labels the backend never
  // emits", which points nowhere near the real cause. This exact mistake has
  // now been made twice, the second time by writing that very regex into a
  // comment here.
  | 'review_duplicate_candidate'
  // RIO-AI-004. merge_needs retires one need into another and moves everything
  // attached to it. undo_need_merge reverses that. Separate from
  // review_duplicate_candidate because deciding a pair IS a duplicate changes
  // nothing, while merging changes a great deal — an auditor asking what moved
  // data must be able to filter to these two alone.
  | 'merge_needs'
  | 'undo_need_merge'
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
  | 'question'
  | 'need_decision'
  // RIO-FR-003 — a reviewer's override of a computed priority score. Its own
  // entity type rather than folded into 'need': the audit reader filters on
  // what was changed, and a score decision is not a change to the need.
  | 'priority_score'
  // RIO-AI-003 — one row per suggested summary of a Need's description.
  | 'need_statement_summary'
  // Client-confirmed (2026-08-27), requirement 5 — "update this in audit log
  // too": every draft/edit/approve/reject/publish of a Terms of Use or Data
  // Sharing Policy version is an auditable governance event in its own right,
  // distinct from `user`-scoped consent acceptance (action: 'consent').
  | 'consent_policy'
  // RIO-FR-002 — one row per data-quality finding a reviewer decided on. Its
  // own entity type rather than folded into 'need': the decision is about the
  // finding, and the write it may cause is audited separately against the
  // record itself.
  | 'cleaning_flag'
  // RIO-FR-002 / RIO-AI-004 — one proposed duplicate pair. Its own entity
  // type rather than 'need': the decision is about the PAIR, and neither need
  // changed as a result of it.
  | 'duplicate_candidate';

  
  // RIO-AI-003 — one row per suggested summary of a Need's description.
  

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
