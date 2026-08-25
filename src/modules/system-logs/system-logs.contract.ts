import { registerSchema, T } from '../../contract/typebox';

// Response schemas (GAP-08 Phase 0) — shape sourced from the frontend's
// SystemLogEntry/SystemLogListResult/SystemLogSummary
// (Project-RIO-Frontend/src/services/system-logs/system-logs.types.ts),
// which itself is documented as mirroring the backend's own
// system-logs.types.ts — the two already agree field-for-field, so no
// discrepancy to flag here (unlike the other three modules in this batch).

const SystemLogLevel = T.Union([
  T.Literal('fatal'),
  T.Literal('error'),
  T.Literal('warn'),
  T.Literal('info'),
]);

const SystemLogCategory = T.Union([
  T.Literal('http'),
  T.Literal('database'),
  T.Literal('auth'),
  T.Literal('integration'),
  T.Literal('job'),
  T.Literal('startup'),
  T.Literal('security'),
  T.Literal('application'),
]);

const SystemLogActor = T.Object({
  id: T.String(),
  name: T.String(),
  email: T.String(),
});

const SystemLogHttp = T.Object({
  method: T.Union([T.String(), T.Null()]),
  path: T.Union([T.String(), T.Null()]),
  statusCode: T.Union([T.Number(), T.Null()]),
  durationMs: T.Union([T.Number(), T.Null()]),
});

export const SystemLogEntry = registerSchema(
  'SystemLogEntry',
  T.Object({
    id: T.String(),
    level: SystemLogLevel,
    category: SystemLogCategory,
    source: T.String(),
    eventCode: T.Union([T.String(), T.Null()]),
    message: T.String(),
    requestId: T.Union([T.String(), T.Null()]),
    organizationId: T.Union([T.String(), T.Null()]),
    organizationName: T.Union([T.String(), T.Null()]),
    actor: T.Union([SystemLogActor, T.Null()]),
    http: SystemLogHttp,
    ipAddress: T.Union([T.String(), T.Null()]),
    userAgent: T.Union([T.String(), T.Null()]),
    stack: T.Union([T.String(), T.Null()]),
    context: T.Union([T.Record(T.String(), T.Unknown()), T.Null()]),
    instanceId: T.Union([T.String(), T.Null()]),
    createdAt: T.String(),
  }),
);

// Paginated envelope — registered as one wrapper schema (GAP-08 P0
// convention, see RouteDoc.responseSchema doc in src/contract/openapi.ts).
export const SystemLogListResult = registerSchema(
  'SystemLogListResult',
  T.Object({
    items: T.Array(SystemLogEntry),
    total: T.Number(),
    limit: T.Number(),
    offset: T.Number(),
  }),
);

export const SystemLogSummary = registerSchema(
  'SystemLogSummary',
  T.Object({
    since: T.String(),
    window: T.Union([T.Literal('1h'), T.Literal('24h'), T.Literal('7d'), T.Literal('30d')]),
    stats: T.Object({
      total: T.Number(),
      fatal: T.Number(),
      error: T.Number(),
      warn: T.Number(),
      info: T.Number(),
      failedRequests: T.Number(),
      slowRequests: T.Number(),
    }),
    byCategory: T.Array(T.Object({ category: SystemLogCategory, count: T.Number() })),
    topEventCodes: T.Array(
      T.Object({
        eventCode: T.String(),
        count: T.Number(),
        lastSeenAt: T.String(),
        sampleMessage: T.String(),
      }),
    ),
    errorTrend: T.Array(T.Object({ hour: T.String(), count: T.Number() })),
  }),
);
