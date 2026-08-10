import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { PasswordService } from '../../auth/password.service';
import { conflictFor, DEFAULT_TEMP_PASSWORD, uniqueField } from '../auth/auth.repository';
import { MailerService } from '../../mailer/mailer.service';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { DomainsService } from '../domains/domains.service';
import { GeographyService } from '../geography/geography.service';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, OrgRow, UpdateOrganizationPayload,
} from './organizations.types';

const DIFF_FIELDS = [
  'name', 'region', 'email', 'sector', 'purpose', 'logoUrl', 'villages',
  'regionId', 'isActive',
] as const;

// Shape Prisma actually returns once the join tables are included — the raw
// input to toOrgRow() below. Kept separate from OrgRow (this module's own
// flattened shape) since the join rows need to be reduced to plain id
// arrays before anything else in this file touches them. `regionId` is a
// plain scalar column now (single-select), so no include/join needed for it.
type RawOrgWithGeo = {
  id: string; name: string; purpose: string | null; registrationNumber: string | null;
  logoUrl: string | null; region: string[]; email: string | null; sector: string | null;
  villages: string[]; regionId: string | null; isActive: boolean; approvedAt: Date | null; createdAt: Date;
  orgGovernorates: { governorateId: string }[];
  orgCenters: { centerId: string }[];
};

const GEO_INCLUDE = { orgGovernorates: true, orgCenters: true } as const;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly domains: DomainsService,
    private readonly geography: GeographyService,
    private readonly mailer: MailerService,
  ) {}

  async getCurrent(): Promise<Organization> {
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.organisation.findFirst({ include: GEO_INCLUDE }),
    );
    if (!row) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
    return this.toOrganization(this.toOrgRow(row as RawOrgWithGeo));
  }

  async updateCurrent(patch: UpdateOrganizationPayload): Promise<Organization> {
    const orgId = requireOrgId();
    if (patch.sector !== undefined) await this.assertValidSector(patch.sector);

    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const currentRaw = await tx.organisation.findFirst({ include: GEO_INCLUDE });
      if (!currentRaw) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
      const current = this.toOrgRow(currentRaw as RawOrgWithGeo);

      // A patch that omits regionId/governorateIds/centerIds leaves that
      // value unchanged — validate against whatever the *final* state will
      // be, not just what's in this one patch.
      const nextRegionId = patch.regionId !== undefined ? patch.regionId : current.regionId;
      const nextGovernorateIds = patch.governorateIds ?? current.governorateIds;
      const nextCenterIds = patch.centerIds ?? current.centerIds;
      await this.geography.validateHierarchy({
        regionId: nextRegionId,
        governorateIds: nextGovernorateIds,
        centerIds: nextCenterIds,
      });

      const changes = this.diff(current, patch, nextGovernorateIds, nextCenterIds);

      await tx.organisation.update({ where: { id: orgId }, data: this.buildUpdateData(patch) });

      if (patch.governorateIds !== undefined) {
        await tx.organisationGovernorate.deleteMany({ where: { orgId } });
        if (patch.governorateIds.length > 0) {
          await tx.organisationGovernorate.createMany({
            data: patch.governorateIds.map((governorateId) => ({ orgId, governorateId })),
          });
        }
      }
      if (patch.centerIds !== undefined) {
        await tx.organisationCenter.deleteMany({ where: { orgId } });
        if (patch.centerIds.length > 0) {
          await tx.organisationCenter.createMany({
            data: patch.centerIds.map((centerId) => ({ orgId, centerId })),
          });
        }
      }

      const updatedRaw = await tx.organisation.findFirst({ include: GEO_INCLUDE });
      return { updated: this.toOrgRow(updatedRaw as RawOrgWithGeo), changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'organization', entityId: updated.id, entityLabel: updated.name, changes });
    }
    return this.toOrganization(updated);
  }

  // System-Admin creates an org + optional first NGO Admin (invited) in one action.
  async createWithAdmin(payload: CreateOrganizationPayload): Promise<Organization> {
    this.assertCrossEntity();
    await this.assertValidSector(payload.sector);
    const orgId = uuidv7();
    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await this.passwords.hash(tempPassword);

    // A duplicate registrationNumber (org) or adminEmail (user) hits a DB
    // unique constraint — map that P2002 to the same clean 409 the public
    // signup path returns, instead of leaking a raw Prisma 500.
    let org: OrgRow;
    try {
      const created = await this.tenant.runAsOrg(orgId, async (tx) => {
        const row = await tx.organisation.create({
          data: {
            id: orgId, name: payload.name, purpose: payload.purpose ?? null, registrationNumber: payload.registrationNumber,
            region: payload.region ?? [], email: payload.email ?? null,
            sector: payload.sector ?? null, villages: payload.villages ?? [], isActive: true,
            // RIO-FR-010 (client-confirmed): the approval gate is only for
            // self-registration — a System Admin creating an org directly is
            // inherently pre-approved, so this skips the gate entirely.
            approvedAt: new Date(), approvedBy: requireActor(),
          },
        });
        if (payload.adminName && payload.adminEmail) {
          await tx.user.create({
            data: { orgId, roleId: 'role_ngo_admin', name: payload.adminName, email: payload.adminEmail, status: UserStatus.invited, passwordHash },
          });
        }
        return row;
      });
      // A freshly-created org has no Governorate/Center selections yet — no
      // join rows exist to fetch, so these are always empty on creation.
      // `regionId` is a plain column, already present on `created` as-is.
      org = { ...(created as unknown as Omit<OrgRow, 'governorateIds' | 'centerIds'>), governorateIds: [], centerIds: [] };
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw conflictFor(field);
      throw err;
    }

    // File under the newly-created org (not the acting system_admin's org) so
    // the creation event is traceable from the new entity's audit trail.
    await this.audit.record({
      action: 'ORGANIZATION_CREATED', entityType: 'organization', entityId: org.id, entityLabel: org.name, organizationId: org.id,
      // before: null on a create — the org's opening state, which later
      // ORGANIZATION_DEACTIVATED / edit events are read against.
      changes: [
        { field: 'Organization name', before: null, after: org.name },
        { field: 'Registration number', before: null, after: org.registrationNumber },
        { field: 'Sector', before: null, after: org.sector },
        { field: 'Active', before: null, after: org.isActive },
      ],
    });
    return this.toOrganization(org);
  }

  async listAll(opts: { limit?: number; offset?: number } = {}): Promise<OrganizationSummary[]> {
    this.assertCrossEntity();
    const take = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findMany({
        include: {
          ...GEO_INCLUDE,
          users: { where: { roleId: 'role_ngo_admin' }, take: 1, select: { name: true, email: true } },
          _count: { select: { users: true, studies: true, surveys: true, reports: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
    );
    return (rows as (RawOrgWithGeo & {
      users: { name: string; email: string }[];
      _count: { users: number; studies: number; surveys: number; reports: number };
    })[]).map((r) => ({
      ...this.toOrganization(this.toOrgRow(r)),
      memberCount: r._count.users,
      studyCount: r._count.studies,
      surveyCount: r._count.surveys,
      reportCount: r._count.reports,
      ngoAdminName: r.users[0]?.name ?? null,
      ngoAdminEmail: r.users[0]?.email ?? null,
    }));
  }

  async getById(id: string): Promise<OrganizationSummary> {
    this.assertCrossEntity();
    const row = (await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findUnique({
        where: { id },
        include: {
          ...GEO_INCLUDE,
          users: { where: { roleId: 'role_ngo_admin' }, take: 1, select: { name: true, email: true } },
          _count: { select: { users: true, studies: true, surveys: true, reports: true } },
        },
      }),
    )) as (RawOrgWithGeo & {
      users: { name: string; email: string }[];
      _count: { users: number; studies: number; surveys: number; reports: number };
    }) | null;

    if (!row) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });

    await this.audit.record({
      action: 'SYSTEM_ADMIN_VIEWED_ORGANIZATION',
      entityType: 'organization',
      entityId: row.id,
      entityLabel: row.name,
      organizationId: row.id,
    });

    return {
      ...this.toOrganization(this.toOrgRow(row)),
      memberCount: row._count.users,
      studyCount: row._count.studies,
      surveyCount: row._count.surveys,
      reportCount: row._count.reports,
      ngoAdminName: row.users[0]?.name ?? null,
      ngoAdminEmail: row.users[0]?.email ?? null,
    };
  }

  async updateStatus(id: string, payload: { isActive: boolean; reason?: string | null }): Promise<OrganizationSummary> {
    this.assertCrossEntity();
    const current = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findUnique({ where: { id } }),
    );
    if (!current) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });

    await this.tenant.runAsOrg(id, (tx) =>
      tx.organisation.update({
        where: { id },
        data: { isActive: payload.isActive },
      }),
    );

    const action = payload.isActive ? 'ORGANIZATION_REACTIVATED' : 'ORGANIZATION_DEACTIVATED';
    await this.audit.record({
      action,
      entityType: 'organization',
      entityId: current.id,
      entityLabel: current.name,
      organizationId: current.id,
      metadata: payload.reason ? { reason: payload.reason } : undefined,
    });

    return this.getById(id);
  }

  // RIO-FR-010 (client-confirmed): self-registered entities require Center
  // (System Admin) approval before activation. Separate from updateStatus
  // above — this issues the entity's real temporary password (a placeholder
  // was hashed at signup and never revealed/emailed, since login was blocked
  // by ORG_INACTIVE regardless — see AuthService.signup), which
  // updateStatus's plain activate/deactivate toggle must never do (it's also
  // used to suspend/reinstate an already-approved, already-credentialed org).
  async approve(id: string): Promise<OrganizationSummary> {
    this.assertCrossEntity();
    const actorId = requireActor();
    const current = (await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findUnique({
        where: { id },
        include: { users: { where: { roleId: 'role_ngo_admin' }, take: 1, select: { id: true, email: true } } },
      }),
    )) as (RawOrgWithGeo & { users: { id: string; email: string }[] }) | null;
    if (!current) throw new NotFoundException({ error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' } });
    if (current.approvedAt) {
      throw new BadRequestException({ error: { code: 'ORG_ALREADY_APPROVED', message: 'This organization has already been approved.' } });
    }
    const admin = current.users[0];
    if (!admin) throw new NotFoundException({ error: { code: 'ORG_ADMIN_NOT_FOUND', message: 'No admin user found for this organization.' } });

    const temporaryPassword = DEFAULT_TEMP_PASSWORD;
    const passwordHash = await this.passwords.hash(temporaryPassword);

    await this.tenant.runAsOrg(id, async (tx) => {
      await tx.organisation.update({ where: { id }, data: { isActive: true, approvedAt: new Date(), approvedBy: actorId } });
      await tx.user.update({ where: { id: admin.id }, data: { passwordHash, mustChangePassword: true } });
    });

    await this.mailer.sendTemporaryPassword(admin.email, current.name, temporaryPassword);

    await this.audit.record({
      action: 'ORGANIZATION_APPROVED',
      entityType: 'organization',
      entityId: current.id,
      entityLabel: current.name,
      organizationId: current.id,
    });

    return this.getById(id);
  }

  // Mirrors AuthService's identical check (see auth.service.ts) — `sector`
  // must match an active Methodology Configuration Domain name or the
  // literal "other" (paired with `purpose` for free text).
  private async assertValidSector(sector: string | null | undefined): Promise<void> {
    if (!sector || sector === 'other') return;
    const domains = await this.domains.listDomains();
    const valid = domains.some((d) => d.isActive && d.name === sector);
    if (!valid) {
      throw new BadRequestException({
        error: { code: 'INVALID_SECTOR', message: 'Sector must match an active domain or "other"' },
      });
    }
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
    if (patch.sector !== undefined) data.sector = patch.sector ?? null;
    if (patch.purpose !== undefined) data.purpose = patch.purpose;
    if (patch.logoUrl !== undefined) data.logoUrl = patch.logoUrl;
    if (patch.villages !== undefined) data.villages = patch.villages;
    if (patch.regionId !== undefined) data.regionId = patch.regionId;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;
    return data;
  }

  private diff(
    current: OrgRow,
    patch: UpdateOrganizationPayload,
    nextGovernorateIds: string[],
    nextCenterIds: string[],
  ): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      if (after[f] !== undefined && JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        // logoUrl is a data: URI (the raw image, base64-encoded) — never put
        // that in the audit trail, just record that it changed, same
        // reasoning as never logging a real password value.
        if (f === 'logoUrl') {
          changes.push({ field: f, before: before[f] ? '(logo)' : null, after: after[f] ? '(logo)' : null });
          continue;
        }
        changes.push({ field: f, before: before[f], after: after[f] });
      }
    }
    // governorateIds/centerIds aren't real columns on `organisations` (they
    // live in the join tables) so DIFF_FIELDS can't cover them generically —
    // diff the *sets* directly against whatever the final set will be.
    if (patch.governorateIds !== undefined && !this.sameIdSet(current.governorateIds, nextGovernorateIds)) {
      changes.push({ field: 'governorateIds', before: current.governorateIds, after: nextGovernorateIds });
    }
    if (patch.centerIds !== undefined && !this.sameIdSet(current.centerIds, nextCenterIds)) {
      changes.push({ field: 'centerIds', before: current.centerIds, after: nextCenterIds });
    }
    return changes;
  }

  private sameIdSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sorted = (xs: string[]) => [...xs].sort();
    return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  }

  // Reduces the raw join-table arrays Prisma returns (once `orgGovernorates`/
  // `orgCenters` are included) down to plain id arrays — every other method
  // in this file works with that flattened OrgRow shape, never the raw join
  // rows directly. `regionId` is a plain scalar column, read straight off.
  private toOrgRow(raw: RawOrgWithGeo): OrgRow {
    return {
      id: raw.id, name: raw.name, purpose: raw.purpose, registrationNumber: raw.registrationNumber,
      logoUrl: raw.logoUrl, region: raw.region, email: raw.email, sector: raw.sector,
      villages: raw.villages, regionId: raw.regionId, isActive: raw.isActive, approvedAt: raw.approvedAt, createdAt: raw.createdAt,
      governorateIds: raw.orgGovernorates.map((g) => g.governorateId),
      centerIds: raw.orgCenters.map((c) => c.centerId),
    };
  }

  private toOrganization(row: OrgRow): Organization {
    return {
      id: row.id, name: row.name, purpose: row.purpose, registrationNumber: row.registrationNumber,
      logoUrl: row.logoUrl, region: row.region, email: row.email,
      sector: row.sector, villages: row.villages,
      regionId: row.regionId, governorateIds: row.governorateIds, centerIds: row.centerIds,
      isActive: row.isActive, approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
