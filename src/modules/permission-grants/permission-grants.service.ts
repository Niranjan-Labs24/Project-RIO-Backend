import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor } from '../../tenancy/org-context';
import { roleById } from '../../rbac/role-matrix';
import type { CreatePermissionGrantPayload, PermissionGrant } from './permission-grants.types';

// RIO-RBAC-002 (client-confirmed) — the exact audit-log fields specified:
// "Grant ID, approver, stated reason/scope, and expiry." `scope` isn't a
// separate field here — every grant applies across all entities (see the
// module comment below), so there's nothing further to cite beyond
// reason+approver+expiry alongside the grantId.
export interface GrantCitation {
  grantId: string;
  approvedBy: string;
  reason: string;
  expiresAt: string | null;
}

// RIO-RBAC-002 (client-confirmed 2026-08-23, and reconfirmed 2026-08-24 —
// "a grant applies across all entities once given, it is not scoped to a
// single entity") — the runtime layer under the static role-matrix. Global
// reference data (no orgId/RLS — same pattern as
// MethodologyConfig/StudyTypeOption), read via the bare PrismaService.
// There is deliberately no per-entity scope on a grant: every grant this
// service creates applies to every organisation the Supervisor might act
// on, full stop.
@Injectable()
export class PermissionGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
  ) {}

  // The one method PermissionGuard actually calls — kept intentionally
  // narrow (no name resolution, no list assembly) since it runs on every
  // gated request for center_supervisor once the static matrix says no.
  async findActiveGrant(
    granteeId: string,
    module: string,
    action: string,
  ): Promise<GrantCitation | null> {
    const now = new Date();
    const match = await this.prisma.permissionGrant.findFirst({
      where: {
        granteeId,
        module,
        action,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, grantedBy: true, reason: true, expiresAt: true },
    });
    if (!match) return null;
    return {
      grantId: match.id,
      approvedBy: match.grantedBy,
      reason: match.reason,
      expiresAt: match.expiresAt ? match.expiresAt.toISOString() : null,
    };
  }

  async list(): Promise<PermissionGrant[]> {
    const rows = await this.prisma.permissionGrant.findMany({ orderBy: { grantedAt: 'desc' } });
    const userIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.granteeId);
      userIds.add(r.grantedBy);
      if (r.revokedBy) userIds.add(r.revokedBy);
    }
    const users = await this.tenant.runAsSupervisor((tx) =>
      tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }),
    );
    const nameByUserId = new Map(users.map((u) => [u.id, u.name]));
    const now = Date.now();
    return rows.map((r) => this.toGrant(r, nameByUserId, now));
  }

  async create(payload: CreatePermissionGrantPayload): Promise<PermissionGrant> {
    const grantedBy = requireActor();

    const grantee = await this.tenant.runAsSupervisor((tx) => tx.user.findUnique({ where: { id: payload.granteeId } }));
    if (!grantee) {
      throw new NotFoundException({ error: { code: 'GRANTEE_NOT_FOUND', message: 'Grantee not found' } });
    }
    // Deliberately restricted to center_supervisor grantees — this
    // mechanism exists specifically for RIO-RBAC-002's Center/NCNP
    // Supervisor authority, not as a general-purpose permission-override
    // tool for arbitrary roles.
    const role = roleById(grantee.roleId);
    if (role?.key !== 'center_supervisor') {
      throw new BadRequestException({
        error: {
          code: 'GRANTEE_NOT_SUPERVISOR',
          message: 'Permission grants can only be issued to a Center/NCNP Supervisor user.',
        },
      });
    }

    const existing = await this.findActiveGrant(payload.granteeId, payload.module, payload.action);
    if (existing) {
      throw new ConflictException({
        error: {
          code: 'GRANT_ALREADY_ACTIVE',
          message: 'An active grant for this user/module/action combination already exists.',
        },
      });
    }

    const row = await this.prisma.permissionGrant.create({
      data: {
        granteeId: payload.granteeId,
        module: payload.module,
        action: payload.action,
        reason: payload.reason,
        grantedBy,
        expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      },
    });
    const now = Date.now();
    return this.toGrant(row, new Map(), now);
  }

  async revoke(id: string): Promise<PermissionGrant> {
    const revokedBy = requireActor();
    const existing = await this.prisma.permissionGrant.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: 'GRANT_NOT_FOUND', message: 'Grant not found' } });
    }
    if (existing.revokedAt) {
      throw new ConflictException({ error: { code: 'GRANT_ALREADY_REVOKED', message: 'This grant is already revoked.' } });
    }
    const row = await this.prisma.permissionGrant.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy },
    });
    const now = Date.now();
    return this.toGrant(row, new Map(), now);
  }

  private toGrant(
    row: {
      id: string;
      granteeId: string;
      module: string;
      action: string;
      reason: string;
      grantedBy: string;
      grantedAt: Date;
      expiresAt: Date | null;
      revokedAt: Date | null;
      revokedBy: string | null;
    },
    nameByUserId: Map<string, string>,
    now: number,
  ): PermissionGrant {
    const isActive = !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > now);
    return {
      id: row.id,
      granteeId: row.granteeId,
      granteeName: nameByUserId.get(row.granteeId) ?? null,
      module: row.module as PermissionGrant['module'],
      action: row.action as PermissionGrant['action'],
      reason: row.reason,
      grantedBy: row.grantedBy,
      grantedByName: nameByUserId.get(row.grantedBy) ?? null,
      grantedAt: row.grantedAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedBy: row.revokedBy,
      revokedByName: row.revokedBy ? (nameByUserId.get(row.revokedBy) ?? null) : null,
      isActive,
    };
  }
}
