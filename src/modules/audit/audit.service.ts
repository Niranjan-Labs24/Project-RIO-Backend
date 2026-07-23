import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import type {
  AuditChange,
  AuditEvent,
  AuditListResult,
  AuditQuery,
  RecordAuditInput,
} from './audit.types';

interface AuditRow {
  id: string;
  organisationId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}
interface ActorRow {
  id: string;
  name: string;
  email: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly tenant: TenantPrismaService) {}

  // Append-only. Writes within the active org context (RLS keyed on
  // organisation_id), capturing actor/ip/ua from the OrgStore. Callers set the
  // org context (authenticated request) before mutating; login sets it after
  // resolving the user.
  async record(input: RecordAuditInput): Promise<void> {
    const store = getOrgStore();
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (input.changes && input.changes.length > 0) {
      metadata.changes = input.changes;
    }
    // File the event under the explicit org when given (cross-org admin action),
    // otherwise under the caller's ambient org. The RLS WITH CHECK requires
    // organisation_id to equal the transaction's org GUC, so both must match.
    const orgId = input.organizationId ?? store?.orgId ?? null;
    const write = (tx: Prisma.TransactionClient): Promise<unknown> =>
      tx.auditLog.create({
        data: {
          organisationId: orgId,
          actorUserId: store?.actorId ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          entityLabel: input.entityLabel,
          metadata:
            Object.keys(metadata).length > 0
              ? (metadata as unknown as Prisma.InputJsonValue)
              : undefined,
          ipAddress: store?.ip ?? null,
          userAgent: store?.userAgent ?? null,
        },
      });
    if (input.organizationId) {
      await this.tenant.runAsOrg(input.organizationId, write);
    } else {
      await this.tenant.runInOrgContext(write);
    }
  }

  // Own-org (ambient) by default; crossEntity roles (system_admin,
  // center_supervisor) read across orgs (all, or a specific organizationId).
  // Filters (entityType/entityId/actorId) support decision→source→actor→time
  // traceability (NFR-004); limit/offset bound the result set (NFR-006).
  async list(opts: AuditQuery & { limit?: number; offset?: number }): Promise<AuditListResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const { logs, actors, total } = await this.query(opts, limit, offset);
    return { items: this.mapRows(logs, actors), total, limit, offset };
  }

  /**
   * Same filters as list(), no pagination cap beyond a hard export ceiling
   * (5000 rows) — CSV today; PDF/Excel return the same placeholder-stub
   * contract Reports export uses (see reports.placeholder.ts) so a future
   * real renderer swap doesn't change the response shape.
   */
  async exportCsv(opts: AuditQuery): Promise<string> {
    const { logs, actors } = await this.query(opts, 5000, 0);
    const events = this.mapRows(logs, actors);
    const header = ['Timestamp', 'Actor', 'Action', 'Entity Type', 'Entity', 'IP Address'];
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const rows = events.map((e) =>
      [e.createdAt, e.actor?.email ?? '', e.action, e.entityType, e.entityLabel, e.ipAddress ?? '']
        .map((v) => escape(String(v)))
        .join(','),
    );
    return [header.map(escape).join(','), ...rows].join('\n');
  }

  private async query(
    opts: AuditQuery,
    limit: number,
    offset: number,
  ): Promise<{ logs: AuditRow[]; actors: ActorRow[]; total: number }> {
    const roleKey = getOrgStore()?.role;
    const crossEntity = roleKey ? roleByKey(roleKey)?.crossEntity === true : false;

    const filters: Record<string, unknown> = {};
    if (opts.entityType) filters.entityType = opts.entityType;
    if (opts.entityId) filters.entityId = opts.entityId;
    if (opts.actorId) filters.actorUserId = opts.actorId;
    if (opts.action) filters.action = opts.action;
    if (opts.dateFrom || opts.dateTo) {
      filters.createdAt = {
        ...(opts.dateFrom ? { gte: new Date(opts.dateFrom) } : {}),
        ...(opts.dateTo ? { lte: new Date(opts.dateTo) } : {}),
      };
    }

    const search = opts.search?.trim();

    const runQuery = async (tx: Prisma.TransactionClient, where: Record<string, unknown>) => {
      // Free-text search spans the entity label and the actor's name/email —
      // the same three fields the Audit Log page searches — but the actor
      // lives on `users`, not `audit_logs`, so matching ids are resolved
      // first and folded into an OR alongside the label match.
      const effectiveWhere = search
        ? { ...where, OR: [
            { entityLabel: { contains: search, mode: 'insensitive' } },
            { actorUserId: { in: await this.findActorIdsMatching(tx, search) } },
          ] }
        : where;
      // `total` counts every match, ignoring limit/offset — the client needs
      // it to render page counts now that filtering happens here.
      const [logs, total] = await Promise.all([
        tx.auditLog.findMany({ where: effectiveWhere, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }) as Promise<AuditRow[]>,
        tx.auditLog.count({ where: effectiveWhere }),
      ]);
      const actors = await this.loadActors(logs);
      return { logs, actors, total };
    };

    if (crossEntity) {
      const where = { ...filters, ...(opts.organizationId ? { organisationId: opts.organizationId } : {}) };
      return this.tenant.runAsSupervisor((tx) => runQuery(tx, where));
    }

    return this.tenant.runInOrgContext((tx) => runQuery(tx, filters));
  }

  /** Ids of users whose name or email matches the free-text search term. */
  private async findActorIdsMatching(_tx: Prisma.TransactionClient, search: string): Promise<string[]> {
    // Cross-org lookup (see loadActors below) — a search term must match an
    // actor regardless of which org's users RLS would otherwise restrict
    // this query to.
    const users = await this.tenant.runAsSupervisor((supTx) =>
      supTx.user.findMany({
        where: {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      }),
    );
    return users.map((u) => u.id);
  }

  // Cross-org lookup, deliberately not scoped to the viewing org's own RLS
  // context: an audit entry can legitimately be filed under one org (e.g.
  // report-sharing's dual-org write — see ReportSharingService.create/
  // decide) while its actor belongs to the *other* org. Resolving the
  // actor under the viewer's own org-scoped `tx` would hide that user
  // behind RLS and silently fall back to "System" even though a real
  // person performed the action — this bypasses that, the same way
  // `organisationId`/entity names on these cross-org events are already
  // resolved via runAsSupervisor elsewhere (see ReportSharingService).
  private async loadActors(logs: AuditRow[]): Promise<ActorRow[]> {
    const ids = [...new Set(logs.map((l) => l.actorUserId).filter((v): v is string => Boolean(v)))];
    if (ids.length === 0) return [];
    return this.tenant.runAsSupervisor((tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }),
    );
  }

  private mapRows(logs: AuditRow[], actors: ActorRow[]): AuditEvent[] {
    const byId = new Map(actors.map((a) => [a.id, a]));
    return logs.map((l) => {
      const meta = (l.metadata && typeof l.metadata === 'object' ? { ...(l.metadata as Record<string, unknown>) } : {}) as Record<string, unknown>;
      const changes = Array.isArray(meta.changes) ? (meta.changes as AuditChange[]) : undefined;
      delete meta.changes;
      const actorRow = l.actorUserId ? byId.get(l.actorUserId) : undefined;
      return {
        id: l.id,
        organizationId: l.organisationId,
        actor: actorRow ? { id: actorRow.id, name: actorRow.name, email: actorRow.email } : null,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        entityLabel: l.entityLabel,
        changes,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
        ipAddress: l.ipAddress,
        userAgent: l.userAgent,
        createdAt: l.createdAt.toISOString(),
      };
    });
  }
}
