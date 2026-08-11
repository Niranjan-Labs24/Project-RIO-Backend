import * as os from 'node:os';
import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import {
  SYSTEM_LOG_LEVELS,
  type RecordSystemLogInput,
  type SystemLogActor,
  type SystemLogCategory,
  type SystemLogEntry,
  type SystemLogLevel,
  type SystemLogListResult,
  type SystemLogQuery,
  type SystemLogSummary,
  type SystemLogSummaryWindow,
} from './system-logs.types';

/** Flush cadence — a partially-filled buffer never waits longer than this. */
const FLUSH_INTERVAL_MS = 2_000;
/** Flush immediately once the buffer reaches this size. */
const FLUSH_BATCH_SIZE = 100;
/** Hard ceiling; beyond it the oldest buffered rows are dropped. Losing old
 *  telemetry is always preferable to an unbounded in-process array. */
const BUFFER_CEILING = 5_000;
const STACK_LIMIT = 8_192;
const CONTEXT_LIMIT = 16_384;
const MESSAGE_LIMIT = 2_000;
const EXPORT_ROW_CAP = 10_000;

const SENSITIVE_KEY = /^(password|passwordhash|token|secret|secretkey|authorization|cookie|otp|apikey|api_key|access_token|refresh_token|refreshtoken)$/i;
/** A bare JWT or bearer token appearing as a *value* rather than under a
 *  telltale key — belt and braces alongside SENSITIVE_KEY above. */
const TOKEN_VALUE = /^(Bearer\s+)?[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const WINDOW_MS: Record<SystemLogSummaryWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

interface SystemLogRow {
  id: string;
  level: SystemLogLevel;
  category: SystemLogCategory;
  source: string;
  eventCode: string | null;
  message: string;
  requestId: string | null;
  organisationId: string | null;
  actorUserId: string | null;
  httpMethod: string | null;
  httpPath: string | null;
  statusCode: number | null;
  durationMs: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  stack: string | null;
  context: Prisma.JsonValue | null;
  instanceId: string | null;
  createdAt: Date;
}

/**
 * RIO-NFR-016 — persists operational events and errors so they can be
 * queried, rather than only streamed to stdout.
 *
 * Two properties this service must never violate:
 *
 * 1. **It cannot fail a caller.** `record()` is synchronous by contract — it
 *    only appends to an in-memory buffer — so no call site awaits it and no
 *    call site can be failed by it. Every path to the database is wrapped and
 *    degrades to a `console.warn`.
 * 2. **It cannot grow without bound.** The buffer has a ceiling, payloads are
 *    truncated, successful requests are sampled, and the table is purged on a
 *    retention window (see SystemLogsRetentionService).
 */
@Injectable()
export class SystemLogsService implements OnModuleDestroy {
  private buffer: Prisma.SystemLogCreateManyInput[] = [];
  private timer?: NodeJS.Timeout;
  private readonly instanceId: string;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
  ) {
    this.instanceId = (process.env.INSTANCE_ID ?? os.hostname()).slice(0, 120);
  }

  /**
   * Buffer one operational event. Fire-and-forget: returns void, never
   * throws, never awaits the database.
   */
  record(input: RecordSystemLogInput): void {
    try {
      if (!this.config.systemLogEnabled) return;
      if (!this.meetsMinLevel(input.level)) return;

      const store = getOrgStore();
      this.buffer.push({
        level: input.level,
        category: input.category,
        source: input.source.slice(0, 120),
        eventCode: input.eventCode ? input.eventCode.slice(0, 80) : null,
        message: String(input.message ?? '').slice(0, MESSAGE_LIMIT),
        requestId: store?.requestId ?? null,
        organisationId: input.organisationId ?? store?.orgId ?? null,
        actorUserId: store?.actorId ?? null,
        httpMethod: input.http?.method ?? null,
        httpPath: input.http?.path ? input.http.path.slice(0, 500) : null,
        statusCode: input.http?.statusCode ?? null,
        durationMs: input.http?.durationMs ?? null,
        ipAddress: store?.ip ?? null,
        userAgent: store?.userAgent ?? null,
        stack: extractStack(input.error),
        context: sanitizeContext(input.context) as Prisma.InputJsonValue | undefined,
        instanceId: this.instanceId,
      });

      // Drop oldest past the ceiling rather than letting a flush outage grow
      // the process's heap without limit.
      if (this.buffer.length > BUFFER_CEILING) {
        this.buffer.splice(0, this.buffer.length - BUFFER_CEILING);
      }

      if (this.buffer.length >= FLUSH_BATCH_SIZE) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (err) {
      // Operational logging must never be able to fail the caller.
      console.warn('System log record warning:', err);
    }
  }

  /**
   * Write everything buffered in one batched insert. Public so tests (and
   * the retention job's own bookkeeping) can force a deterministic flush.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.buffer.splice(0, this.buffer.length);
    if (batch.length === 0) return;
    try {
      // runAsSupervisorWrite = the read-write cnap_app client with no org
      // GUC set. Correct here: system_logs has no RLS policy to bypass, and
      // rows are cross-org by nature (many have no org at all).
      await this.tenant.runAsSupervisorWrite((tx) => tx.systemLog.createMany({ data: batch }));
    } catch (err) {
      // Deliberately not re-buffered: if the database is the thing that's
      // broken, retrying the write that just failed is how a logger turns
      // an outage into an outage plus a memory leak. stdout still has every
      // one of these lines.
      console.warn(`System log flush failed, dropping ${batch.length} row(s):`, err);
    }
  }

  /** Flush anything buffered on shutdown so a clean stop loses nothing. */
  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Don't hold the event loop open for a pending flush.
    this.timer.unref?.();
  }

  private meetsMinLevel(level: SystemLogLevel): boolean {
    const min = this.config.systemLogMinLevel;
    return SYSTEM_LOG_LEVELS.indexOf(level) <= SYSTEM_LOG_LEVELS.indexOf(min);
  }

  // ──────── Read paths (System Admin only — see systemLogs permission) ────────

  async list(opts: SystemLogQuery & { limit?: number; offset?: number }): Promise<SystemLogListResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = buildWhere(opts);

    const { rows, total } = await this.tenant.runAsSupervisor(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.systemLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }) as Promise<SystemLogRow[]>,
        tx.systemLog.count({ where }),
      ]);
      return { rows, total };
    });

    return { items: await this.mapRows(rows), total, limit, offset };
  }

  async getById(id: string): Promise<SystemLogEntry> {
    const row = (await this.tenant.runAsSupervisor((tx) =>
      tx.systemLog.findUnique({ where: { id } }),
    )) as SystemLogRow | null;
    if (!row) {
      throw new NotFoundException({
        error: { code: 'SYSTEM_LOG_NOT_FOUND', message: 'System log entry not found' },
      });
    }
    const [mapped] = await this.mapRows([row]);
    if (!mapped) {
      throw new NotFoundException({
        error: { code: 'SYSTEM_LOG_NOT_FOUND', message: 'System log entry not found' },
      });
    }
    return mapped;
  }

  /**
   * Every row sharing one request id, oldest first — the "what else happened
   * in the request that failed?" view the correlation fields in
   * logger.config.ts exist to make answerable.
   */
  async getByRequestId(requestId: string): Promise<{ items: SystemLogEntry[] }> {
    const rows = (await this.tenant.runAsSupervisor((tx) =>
      tx.systemLog.findMany({
        where: { requestId },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }),
    )) as SystemLogRow[];
    return { items: await this.mapRows(rows) };
  }

  async getSummary(window: SystemLogSummaryWindow = '24h'): Promise<SystemLogSummary> {
    const since = new Date(Date.now() - WINDOW_MS[window]);
    const where = { createdAt: { gte: since } };

    return this.tenant.runAsSupervisor(async (tx) => {
      const [total, byLevel, byCategory, failedRequests, slowRequests, topCodes, trend] =
        await Promise.all([
          tx.systemLog.count({ where }),
          tx.systemLog.groupBy({ by: ['level'], where, _count: { _all: true } }),
          tx.systemLog.groupBy({ by: ['category'], where, _count: { _all: true } }),
          // Distinct failing requests, not failing rows — one 500 that logs
          // three lines is one broken request, and counting rows would
          // overstate it.
          tx.systemLog
            .findMany({
              where: { ...where, level: { in: ['error', 'fatal'] }, requestId: { not: null } },
              distinct: ['requestId'],
              select: { requestId: true },
            })
            .then((rows) => rows.length),
          tx.systemLog.count({ where: { ...where, eventCode: 'HTTP_SLOW' } }),
          tx.systemLog.groupBy({
            by: ['eventCode'],
            where: { ...where, level: { in: ['error', 'fatal'] }, eventCode: { not: null } },
            _count: { _all: true },
            _max: { createdAt: true },
            orderBy: { _count: { eventCode: 'desc' } },
            take: 10,
          }),
          tx.$queryRaw<Array<{ hour: Date; count: bigint }>>`
            SELECT date_trunc('hour', "created_at") AS hour, COUNT(*)::bigint AS count
            FROM "system_logs"
            WHERE "created_at" >= ${since} AND "level" IN ('error', 'fatal')
            GROUP BY 1
            ORDER BY 1 ASC
          `,
        ]);

      const levelCount = (level: SystemLogLevel): number =>
        byLevel.find((r) => r.level === level)?._count._all ?? 0;

      // One representative message per event code, so the triage panel shows
      // what the failure actually says rather than just its code.
      const samples = await Promise.all(
        topCodes.map((c) =>
          tx.systemLog.findFirst({
            where: { ...where, eventCode: c.eventCode },
            orderBy: { createdAt: 'desc' },
            select: { message: true },
          }),
        ),
      );

      return {
        since: since.toISOString(),
        window,
        stats: {
          total,
          fatal: levelCount('fatal'),
          error: levelCount('error'),
          warn: levelCount('warn'),
          info: levelCount('info'),
          failedRequests,
          slowRequests,
        },
        byCategory: byCategory.map((r) => ({
          category: r.category as SystemLogCategory,
          count: r._count._all,
        })),
        topEventCodes: topCodes.map((c, i) => ({
          eventCode: c.eventCode ?? '',
          count: c._count._all,
          lastSeenAt: (c._max.createdAt ?? since).toISOString(),
          sampleMessage: samples[i]?.message ?? '',
        })),
        errorTrend: trend.map((t) => ({ hour: t.hour.toISOString(), count: Number(t.count) })),
      };
    });
  }

  /**
   * CSV export. `stack` and `context` are deliberately excluded — they are
   * multi-KB blobs that destroy the file's usability in a spreadsheet; the
   * detail drawer is where those belong.
   */
  async exportCsv(opts: SystemLogQuery): Promise<string> {
    const where = buildWhere(opts);
    const rows = (await this.tenant.runAsSupervisor((tx) =>
      tx.systemLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: EXPORT_ROW_CAP }),
    )) as SystemLogRow[];
    const entries = await this.mapRows(rows);

    const header = [
      'Timestamp',
      'Level',
      'Category',
      'Source',
      'Event Code',
      'Message',
      'Status',
      'Duration (ms)',
      'Request ID',
      'Organization',
      'Actor Email',
      'IP Address',
    ];
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const body = entries.map((e) =>
      [
        e.createdAt,
        e.level,
        e.category,
        e.source,
        e.eventCode ?? '',
        e.message,
        e.http.statusCode ?? '',
        e.http.durationMs ?? '',
        e.requestId ?? '',
        e.organizationName ?? '',
        e.actor?.email ?? '',
        e.ipAddress ?? '',
      ]
        .map((v) => escape(String(v)))
        .join(','),
    );
    return [header.map(escape).join(','), ...body].join('\n');
  }

  /**
   * Retention purge — one bounded chunk per call, returning how many rows it
   * removed so the caller can loop until drained. Chunked on purpose: a
   * single unbounded DELETE on a hot append-only table is a lock hazard.
   *
   * Runs on the cnap_app client, which holds DELETE plus a column-level
   * SELECT on (id, created_at) only — see the migration's grant block.
   */
  async purgeBatch(cutoff: Date, chunkSize = 10_000): Promise<number> {
    return this.tenant.runAsSupervisorWrite(async (tx) => {
      const deleted = await tx.$executeRaw`
        DELETE FROM "system_logs"
        WHERE "id" IN (
          SELECT "id" FROM "system_logs" WHERE "created_at" < ${cutoff} LIMIT ${chunkSize}
        )
      `;
      return deleted;
    });
  }

  /**
   * Org names and actor identities are resolved in one batched lookup per
   * page rather than per row, and through the supervisor client — an
   * operational row's org is not the viewer's org, so an org-scoped read
   * would silently blank most of them.
   */
  private async mapRows(rows: SystemLogRow[]): Promise<SystemLogEntry[]> {
    if (rows.length === 0) return [];

    const orgIds = [...new Set(rows.map((r) => r.organisationId).filter(isNonEmpty))];
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(isNonEmpty))];

    const [orgs, actors] = await this.tenant.runAsSupervisor(async (tx) =>
      Promise.all([
        orgIds.length
          ? tx.organisation.findMany({
              where: { id: { in: orgIds } },
              select: { id: true, name: true },
            })
          : Promise.resolve([]),
        actorIds.length
          ? tx.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, name: true, email: true },
            })
          : Promise.resolve([]),
      ]),
    );

    const orgById = new Map(orgs.map((o) => [o.id, o.name]));
    const actorById = new Map<string, SystemLogActor>(actors.map((a) => [a.id, a]));

    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      category: r.category,
      source: r.source,
      eventCode: r.eventCode,
      message: r.message,
      requestId: r.requestId,
      organizationId: r.organisationId,
      organizationName: r.organisationId ? (orgById.get(r.organisationId) ?? null) : null,
      actor: r.actorUserId ? (actorById.get(r.actorUserId) ?? null) : null,
      http: {
        method: r.httpMethod,
        path: r.httpPath,
        statusCode: r.statusCode,
        durationMs: r.durationMs,
      },
      ipAddress: r.ipAddress,
      userAgent: r.userAgent,
      stack: r.stack,
      context:
        r.context && typeof r.context === 'object' && !Array.isArray(r.context)
          ? (r.context as Record<string, unknown>)
          : null,
      instanceId: r.instanceId,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function isNonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function buildWhere(opts: SystemLogQuery): Prisma.SystemLogWhereInput {
  const where: Prisma.SystemLogWhereInput = {};

  if (opts.level) {
    where.level = opts.level;
  } else if (opts.minLevel) {
    // "warn and above" — the levels array is ordered loudest-first, so
    // everything up to and including the requested index qualifies.
    where.level = { in: SYSTEM_LOG_LEVELS.slice(0, SYSTEM_LOG_LEVELS.indexOf(opts.minLevel) + 1) };
  }
  if (opts.category) where.category = opts.category;
  if (opts.source) where.source = opts.source;
  if (opts.eventCode) where.eventCode = opts.eventCode;
  if (opts.requestId) where.requestId = opts.requestId;
  if (opts.organizationId) where.organisationId = opts.organizationId;
  if (opts.actorId) where.actorUserId = opts.actorId;
  if (opts.statusCode !== undefined) where.statusCode = opts.statusCode;
  if (opts.dateFrom || opts.dateTo) {
    where.createdAt = {
      ...(opts.dateFrom ? { gte: new Date(opts.dateFrom) } : {}),
      ...(opts.dateTo ? { lte: new Date(opts.dateTo) } : {}),
    };
  }
  const search = opts.search?.trim();
  if (search) {
    where.OR = [
      { message: { contains: search, mode: 'insensitive' } },
      { source: { contains: search, mode: 'insensitive' } },
    ];
  }
  return where;
}

/** Pull a stack (or a best-effort string) off whatever was thrown. */
function extractStack(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) return (error.stack ?? error.message).slice(0, STACK_LIMIT);
  if (typeof error === 'string') return error.slice(0, STACK_LIMIT);
  try {
    return JSON.stringify(error).slice(0, STACK_LIMIT);
  } catch {
    return String(error).slice(0, STACK_LIMIT);
  }
}

/**
 * Redact and size-cap a context object. Second line of defence — pino's
 * `redact` list is the first, and neither excuses a call site passing a
 * request body in here.
 */
export function sanitizeContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const redacted = redactDeep(context, 0) as Record<string, unknown>;
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted) ?? '';
  } catch {
    return { _unserializable: true };
  }
  if (serialized.length <= CONTEXT_LIMIT) return redacted;
  // Too big to keep whole: keep the truncated text so it is still readable,
  // and flag it so nobody mistakes it for the complete payload.
  return { _truncated: true, _preview: serialized.slice(0, CONTEXT_LIMIT) };
}

function redactDeep(value: unknown, depth: number): unknown {
  if (depth > 6) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = '[REDACTED]';
      } else if (typeof val === 'string' && TOKEN_VALUE.test(val)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactDeep(val, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && TOKEN_VALUE.test(value)) return '[REDACTED]';
  return value;
}
