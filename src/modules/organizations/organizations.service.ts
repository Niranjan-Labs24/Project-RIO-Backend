import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { Sector, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { PasswordService } from '../../auth/password.service';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, OrgRow, UpdateOrganizationPayload,
} from './organizations.types';

const DIFF_FIELDS = ['name', 'region', 'email', 'sector', 'logoUrl', 'villages', 'isActive'] as const;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  async getCurrent(): Promise<Organization> {
    const row = (await this.tenant.runInOrgContext((tx) => tx.organisation.findFirst())) as OrgRow | null;
    if (!row) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
    return this.toOrganization(row);
  }

  async updateCurrent(patch: UpdateOrganizationPayload): Promise<Organization> {
    const orgId = requireOrgId();
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.organisation.findFirst()) as OrgRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
      const changes = this.diff(current, patch);
      const updated = (await tx.organisation.update({ where: { id: orgId }, data: this.buildUpdateData(patch) })) as OrgRow;
      return { updated, changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'organization', entityId: updated.id, entityLabel: updated.name, changes });
    }
    return this.toOrganization(updated);
  }

  // System-Admin creates an org + its first NGO Admin (invited) in one action.
  async createWithAdmin(payload: CreateOrganizationPayload): Promise<Organization> {
    this.assertCrossEntity();
    const orgId = uuidv7();
    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await this.passwords.hash(tempPassword);

    const org = (await this.tenant.runAsOrg(orgId, async (tx) => {
      const created = await tx.organisation.create({
        data: {
          id: orgId, name: payload.name, region: payload.region ?? null, email: payload.email ?? null,
          sector: payload.sector ? (payload.sector as Sector) : null, villages: payload.villages ?? [], isActive: true,
        },
      });
      await tx.user.create({
        data: { orgId, roleId: 'role_ngo_admin', name: payload.adminName, email: payload.adminEmail, status: UserStatus.invited, passwordHash },
      });
      return created;
    })) as OrgRow;

    // Dev only: surface the first-admin temp password (a real invite/reset flow supersedes this).
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Created org ${payload.name}: admin ${payload.adminEmail} temp password: ${tempPassword}`);
    }
    await this.audit.record({ action: 'create', entityType: 'organization', entityId: org.id, entityLabel: org.name });
    return this.toOrganization(org);
  }

  async listAll(opts: { limit?: number; offset?: number } = {}): Promise<OrganizationSummary[]> {
    this.assertCrossEntity();
    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findMany({ include: { _count: { select: { users: true } } }, orderBy: { createdAt: 'desc' }, take, skip }),
    );
    return (rows as (OrgRow & { _count: { users: number } })[]).map((r) => ({ ...this.toOrganization(r), memberCount: r._count.users }));
  }

  async getById(id: string): Promise<OrganizationSummary> {
    this.assertCrossEntity();
    const row = (await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findUnique({ where: { id }, include: { _count: { select: { users: true } } } }),
    )) as (OrgRow & { _count: { users: number } }) | null;
    if (!row) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
    return { ...this.toOrganization(row), memberCount: row._count.users };
  }

  private assertCrossEntity(): void {
    const roleKey = getOrgStore()?.role;
    if (!roleKey || roleByKey(roleKey)?.crossEntity !== true) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Cross-entity access required' } });
    }
  }

  private buildUpdateData(patch: UpdateOrganizationPayload): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.region !== undefined) data.region = patch.region;
    if (patch.email !== undefined) data.email = patch.email;
    if (patch.sector !== undefined) data.sector = patch.sector ? (patch.sector as Sector) : null;
    if (patch.logoUrl !== undefined) data.logoUrl = patch.logoUrl;
    if (patch.villages !== undefined) data.villages = patch.villages;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;
    return data;
  }

  private diff(current: OrgRow, patch: UpdateOrganizationPayload): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      if (after[f] !== undefined && JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        changes.push({ field: f, before: before[f], after: after[f] });
      }
    }
    return changes;
  }

  private toOrganization(row: OrgRow): Organization {
    return {
      id: row.id, name: row.name, logoUrl: row.logoUrl, region: row.region, email: row.email,
      sector: row.sector, villages: row.villages, isActive: row.isActive, createdAt: row.createdAt.toISOString(),
    };
  }
}
