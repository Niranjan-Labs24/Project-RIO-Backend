import { registerSchema, T } from '../../contract/typebox';

// Response schemas (GAP-08 Phase 0) — shape sourced from the frontend's
// AuditEvent/AuditActor/AuditFieldChange/AuditListResult
// (Project-RIO-Frontend/src/services/audit/audit.types.ts).
//
// NOTE (discrepancy, not fixed here): the backend's actual AuditEvent
// (audit.types.ts) types `action`/`entityType` as plain `string` rather
// than the frontend's closed AuditAction/AuditEntityType unions, and
// `changes[].before`/`after` as `unknown` rather than `string | null`.
// Registered here per the frontend shape as instructed (source of truth
// for Phase 3) — flagged for reconciliation.

const AuditActor = T.Object({
  id: T.String(),
  name: T.String(),
  email: T.String(),
});

const AuditFieldChange = T.Object({
  field: T.String(),
  before: T.Union([T.String(), T.Null()]),
  after: T.Union([T.String(), T.Null()]),
});

export const AuditEvent = registerSchema(
  'AuditEvent',
  T.Object({
    id: T.String(),
    organizationId: T.Union([T.String(), T.Null()]),
    actor: T.Union([AuditActor, T.Null()]),
    action: T.String(),
    entityType: T.String(),
    entityId: T.Union([T.String(), T.Null()]),
    entityLabel: T.String(),
    changes: T.Optional(T.Array(AuditFieldChange)),
    metadata: T.Optional(T.Record(T.String(), T.Unknown())),
    sourceRef: T.Optional(T.Union([T.String(), T.Null()])),
    ipAddress: T.Optional(T.Union([T.String(), T.Null()])),
    userAgent: T.Optional(T.Union([T.String(), T.Null()])),
    createdAt: T.String(),
  }),
);

// Paginated envelope — registered as one wrapper schema (GAP-08 P0
// convention, see RouteDoc.responseSchema doc in src/contract/openapi.ts).
export const AuditListResult = registerSchema(
  'AuditListResult',
  T.Object({
    items: T.Array(AuditEvent),
    total: T.Number(),
    limit: T.Number(),
    offset: T.Number(),
  }),
);
