import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore } from '../../tenancy/org-context';
import type { RecordAuditInput } from './audit.types';

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
}
