import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import type { AuditChange, AuditEvent, RecordAuditInput } from './audit.types';

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
    await this.tenant.runInOrgContext((tx) =>
      tx.auditLog.create({
        data: {
          organisationId: store?.orgId ?? null,
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
      }),
    );
  }

  // Own-org (ambient) by default; crossEntity roles (system_admin,
  // center_supervisor) read across orgs (all, or a specific organizationId).
  async list(opts: { limit?: number; organizationId?: string }): Promise<AuditEvent[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const roleKey = getOrgStore()?.role;
    const crossEntity = roleKey ? roleByKey(roleKey)?.crossEntity === true : false;

    if (crossEntity) {
      const where = opts.organizationId ? { organisationId: opts.organizationId } : {};
      const { logs, actors } = await this.tenant.runAsSupervisor(async (tx) => {
        const logs = (await tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit })) as AuditRow[];
        const actors = await this.loadActors(tx, logs);
        return { logs, actors };
      });
      return this.mapRows(logs, actors);
    }

    const { logs, actors } = await this.tenant.runInOrgContext(async (tx) => {
      const logs = (await tx.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit })) as AuditRow[];
      const actors = await this.loadActors(tx, logs);
      return { logs, actors };
    });
    return this.mapRows(logs, actors);
  }

  private async loadActors(tx: Prisma.TransactionClient, logs: AuditRow[]): Promise<ActorRow[]> {
    const ids = [...new Set(logs.map((l) => l.actorUserId).filter((v): v is string => Boolean(v)))];
    if (ids.length === 0) return [];
    return tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
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
