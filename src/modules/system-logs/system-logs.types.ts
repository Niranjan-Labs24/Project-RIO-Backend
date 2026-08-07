/**
 * RIO-NFR-016 — operational logging.
 *
 * Deliberately distinct from the audit module (RIO-FR-007): that records
 * business decisions with an attributed human actor and keeps them forever;
 * this records what the *system* did — errors, failed integrations, slow
 * requests, job outcomes — and purges on a retention window.
 */

export type SystemLogLevel = 'fatal' | 'error' | 'warn' | 'info';

export type SystemLogCategory =
  | 'http'
  | 'database'
  | 'auth'
  | 'integration'
  | 'job'
  | 'startup'
  | 'security'
  | 'application';

/** Ordered loudest-first — index comparison implements the `minLevel` filter. */
export const SYSTEM_LOG_LEVELS: readonly SystemLogLevel[] = ['fatal', 'error', 'warn', 'info'];

export const SYSTEM_LOG_CATEGORIES: readonly SystemLogCategory[] = [
  'http',
  'database',
  'auth',
  'integration',
  'job',
  'startup',
  'security',
  'application',
];

export function isSystemLogLevel(value: unknown): value is SystemLogLevel {
  return typeof value === 'string' && (SYSTEM_LOG_LEVELS as readonly string[]).includes(value);
}

export function isSystemLogCategory(value: unknown): value is SystemLogCategory {
  return (
    typeof value === 'string' && (SYSTEM_LOG_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * What a call site passes in. Correlation fields (requestId, orgId, actor,
 * ip, user agent) are filled from the AsyncLocalStorage org store — callers
 * never thread them through.
 */
export interface RecordSystemLogInput {
  level: SystemLogLevel;
  category: SystemLogCategory;
  /** Emitting class/service name, e.g. 'MailerService'. */
  source: string;
  message: string;
  /** Stable grouping code, e.g. 'MAILER_SEND_FAILED'. */
  eventCode?: string;
  /** Error (or anything thrown) — stack extracted and truncated by the service. */
  error?: unknown;
  /** Structured detail. Redacted and size-capped before persisting. */
  context?: Record<string, unknown>;
  /** HTTP shape — supplied by the interceptor/exception filter only. */
  http?: {
    method?: string;
    path?: string;
    statusCode?: number;
    durationMs?: number;
  };
  /** Explicit org when the affected tenant isn't the ambient one. */
  organisationId?: string | null;
}

export interface SystemLogActor {
  id: string;
  name: string;
  email: string;
}

export interface SystemLogEntry {
  id: string;
  level: SystemLogLevel;
  category: SystemLogCategory;
  source: string;
  eventCode: string | null;
  message: string;
  requestId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  actor: SystemLogActor | null;
  http: {
    method: string | null;
    path: string | null;
    statusCode: number | null;
    durationMs: number | null;
  };
  ipAddress: string | null;
  userAgent: string | null;
  stack: string | null;
  context: Record<string, unknown> | null;
  instanceId: string | null;
  createdAt: string;
}

/** Filters shared by the list and CSV-export endpoints. */
export interface SystemLogQuery {
  level?: SystemLogLevel;
  /** `minLevel=warn` returns warn + error + fatal — the common triage filter. */
  minLevel?: SystemLogLevel;
  category?: SystemLogCategory;
  source?: string;
  eventCode?: string;
  requestId?: string;
  organizationId?: string;
  actorId?: string;
  statusCode?: number;
  /** ISO-8601 instant; inclusive lower bound on `createdAt`. */
  dateFrom?: string;
  /** ISO-8601 instant; inclusive upper bound on `createdAt`. */
  dateTo?: string;
  /** Free text matched against the message and the emitting source. */
  search?: string;
}

/** Same `{ items, total, limit, offset }` envelope the audit list uses. */
export interface SystemLogListResult {
  items: SystemLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export type SystemLogSummaryWindow = '1h' | '24h' | '7d' | '30d';

export interface SystemLogSummary {
  /** Start of the window the counts cover, ISO-8601. */
  since: string;
  window: SystemLogSummaryWindow;
  stats: {
    total: number;
    fatal: number;
    error: number;
    warn: number;
    info: number;
    /** Distinct request ids that produced at least one error/fatal row. */
    failedRequests: number;
    /** Requests recorded as over the slow-request threshold. */
    slowRequests: number;
  };
  byCategory: Array<{ category: SystemLogCategory; count: number }>;
  /** Loudest failures — drives the "top failures" triage panel. */
  topEventCodes: Array<{
    eventCode: string;
    count: number;
    lastSeenAt: string;
    sampleMessage: string;
  }>;
  /** Hourly error+fatal counts for the sparkline. */
  errorTrend: Array<{ hour: string; count: number }>;
}
