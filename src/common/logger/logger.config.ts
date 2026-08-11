import type { Params } from 'nestjs-pino';
import { getOrgStore } from '../../tenancy/org-context';

/**
 * Correlation fields stamped on every log line — the request id and, once
 * tenant context is established, the org id. Both come from the
 * async-local-storage-backed org context, so they are available to any code
 * running inside a request without being threaded through call sites.
 *
 * Returns a sparse object on purpose: outside a request (startup, shutdown,
 * scheduled jobs) there is no store, and pino omits undefined values rather
 * than emitting `"requestId": null`.
 */
function correlationFields(): { requestId?: string; orgId?: string } {
  const store = getOrgStore();
  return { requestId: store?.requestId, orgId: store?.orgId };
}

export function buildLoggerConfig(level: string): Params {
  return {
    pinoHttp: {
      level,
      // RIO-NFR-016 — `mixin` runs for EVERY log line this logger (and any
      // child of it) emits, which is what makes operational logs queryable
      // by request/tenant.
      //
      // `customProps` below cannot do this job alone: pino-http applies it
      // only to its own "request completed"/"request errored" lines (see
      // pino-http's logger.js), so an error logged from inside a service —
      // a failed email, an AI classification failure, an import error —
      // came out with no requestId and no orgId at all. That made it
      // impossible to answer either of the two questions an operational log
      // exists to answer: "what else happened in the request that failed?"
      // and "which tenant was affected?".
      mixin: correlationFields,
      // Kept for the request/response lines specifically. Redundant with the
      // mixin for these fields, but harmless (identical values merged into
      // the same object) and it keeps the request-line contract explicit
      // rather than implicit in a global mixin.
      customProps: correlationFields,
      // Never log request bodies (PII risk) — see the redact list below.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-org-id"]'],
        remove: true,
      },
      autoLogging: true,
      serializers: {
        req: (req: { id: unknown; method: unknown; url: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
    },
  };
}
