import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { ConsentPolicyKind, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { PasswordService } from '../../auth/password.service';
import { conflictFor, DEFAULT_TEMP_PASSWORD, uniqueField, type ConsentAcceptanceInput } from '../auth/auth.repository';
import { MailerService } from '../../mailer/mailer.service';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { ConsentService } from '../consent/consent.service';
import { consentPolicyTextFor, DEFAULT_CONSENT_LOCALE, resolveConsentLocale } from '../consent/consent.types';
import { DomainsService } from '../domains/domains.service';
import { GeographyService } from '../geography/geography.service';
import { NicRegistryService } from '../nic-registry/nic-registry.service';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, OrgRow, UpdateOrganizationPayload,
} from './organizations.types';

const DIFF_FIELDS = [
  'name', 'region', 'email', 'sector', 'purpose', 'logoUrl', 'villages',
  'regionId', 'isActive',
] as const;

// RIO MFA — same punctuation-stripping normalization as
// UsersService/CitizenService's own normalizeMobile(), kept in step so a
// number captured here at org-creation time matches however AuthService
// later normalizes what a user types into "Sign in with OTP".
function normalizeMobile(mobile: string): string {
  return mobile.trim().replace(/[\s\-()]/g, '');
}

// The technical home organisation for System Admin/System Reviewer (see
// prisma/seed-helpers.ts and RIO-RBAC-002's platform-wide scoping) — not a
// real NGO tenant, so it's excluded from the Organizations list a real
// entity-management screen shows. Matched by its fixed registration number
// (client-confirmed sentinel, same one the seed script uses), not by name,
// since a display name is editable and shouldn't be load-bearing.
const PLATFORM_ADMIN_REGISTRATION_NUMBER = '8000000000';

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
    private readonly nicRegistry: NicRegistryService,
    private readonly consentPolicies: ConsentService,
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
    // Same NIC-registry gate as public self-signup (AuthService.signup) —
    // a System-Admin-created org can't carry a number nobody checked.
    // Returns the normalized 10-digit form, which is what gets stored.
    const registrationNumber = await this.nicRegistry.assertRegistered(payload.registrationNumber);
    // Existence + hierarchy only, same call self-signup makes — every
    // Governorate must belong to the chosen Region, every Center to a
    // chosen Governorate.
    await this.geography.validateHierarchy({
      regionId: payload.regionId,
      governorateIds: payload.governorateIds,
      centerIds: payload.centerIds,
    });
    // RIO-DATA-001 — an NGO Admin created this way still needs both consents
    // on record, same as one created through self-signup; only relevant when
    // an admin is actually being created in this call. Resolved before the
    // transaction, same as the NIC-registry/geography checks above: nothing
    // gets written until every precondition holds.
    const creatingAdmin = Boolean(payload.adminName && payload.adminEmail);
    const consents = creatingAdmin
      ? await this.resolveOrgAdminConsents(payload.consent)
      : [];
    const orgId = uuidv7();
    // A known constant, not a random throwaway value — the whole point is
    // this admin can actually log in with it. AuthRepository.
    // createOrganisationAndAdmin's placeholder and OrganizationsService#
    // approve's temporary password use the very same constant, for the very
    // same reason: a password nobody (not even this System Admin) can ever
    // learn is not a credential, it's a locked account.
    const passwordHash = await this.passwords.hash(DEFAULT_TEMP_PASSWORD);

    // A duplicate registrationNumber (org) or adminEmail (user) hits a DB
    // unique constraint — map that P2002 to the same clean 409 the public
    // signup path returns, instead of leaking a raw Prisma 500.
    let org: OrgRow;
    try {
      const created = await this.tenant.runAsOrg(orgId, async (tx) => {
        const row = await tx.organisation.create({
          data: {
            id: orgId, name: payload.name, purpose: payload.purpose ?? null, registrationNumber,
            region: payload.region ?? [], email: payload.email ?? null,
            sector: payload.sector, villages: payload.villages ?? [], isActive: true,
            regionId: payload.regionId,
            // Nested under the parent create (orgId implied by the relation),
            // same pattern AuthRepository#createOrganisationAndAdmin uses for
            // self-signup — a System-Admin-created org gets its geography
            // scope from day one instead of it staying empty until someone
            // edits the org later.
            orgGovernorates: {
              createMany: { data: payload.governorateIds.map((governorateId) => ({ governorateId })) },
            },
            orgCenters: {
              createMany: { data: payload.centerIds.map((centerId) => ({ centerId })) },
            },
            // RIO-FR-010 (client-confirmed): the approval gate is only for
            // self-registration — a System Admin creating an org directly is
            // inherently pre-approved, so this skips the gate entirely.
            approvedAt: new Date(), approvedBy: requireActor(),
          },
        });
        if (payload.adminName && payload.adminEmail) {
          const usePolicy = consents.find((c) => c.kind === ConsentPolicyKind.use_policy);
          const dataSharing = consents.find((c) => c.kind === ConsentPolicyKind.data_sharing);
          const consentedAt = new Date();
          const user = await tx.user.create({
            data: {
              orgId, roleId: 'role_ngo_admin', name: payload.adminName, email: payload.adminEmail,
              mobileNumber: payload.adminMobileNumber ? normalizeMobile(payload.adminMobileNumber) : null,
              status: UserStatus.invited, passwordHash,
              // Without this, the admin's very first sign-in only ever gets
              // INVALID_CREDENTIALS-shaped confusion resolved by reading
              // source — mustChangePassword is what forces the temp
              // password to be replaced on first login instead of staying
              // valid indefinitely.
              mustChangePassword: true,
              // RIO-DATA-001 — stamped here, at creation, same as
              // AuthRepository#createOrganisationAndAdmin's self-signup
              // path: this admin never lands on a post-login consent gate
              // (there isn't one — see the (app)/layout.tsx comment on why),
              // so consent has to already be on record the moment the
              // account exists.
              consentedAt: usePolicy ? consentedAt : null, consentedPolicyVersion: usePolicy?.version ?? null,
              sharingConsentedAt: dataSharing ? consentedAt : null, sharingConsentedPolicyVersion: dataSharing?.version ?? null,
            },
          });
          // Snapshot the exact text each policy was accepted as — the
          // acceptance record has to stand on its own even after the policy
          // text is later edited or superseded.
          await tx.consentAcceptance.createMany({
            data: consents.map((c) => ({
              orgId, userId: user.id, kind: c.kind, policyVersion: c.version,
              policyText: c.text, policyLocale: c.locale, acceptedAt: consentedAt,
            })),
          });
        }
        return row;
      });
      org = {
        ...(created as unknown as Omit<OrgRow, 'governorateIds' | 'centerIds'>),
        governorateIds: payload.governorateIds,
        centerIds: payload.centerIds,
      };
    } catch (err) {
      const field = uniqueField(err);
      if (field) throw conflictFor(field);
      throw err;
    }

    // Best-effort, same as OrganizationsService#approve: a failed/unconfigured
    // send doesn't undo the org or admin that already exist, and
    // DEFAULT_TEMP_PASSWORD is a known constant either way, not a secret
    // that only this email carries.
    if (payload.adminName && payload.adminEmail) {
      await this.mailer.sendTemporaryPassword(payload.adminEmail, payload.name, DEFAULT_TEMP_PASSWORD);
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
        where: { registrationNumber: { not: PLATFORM_ADMIN_REGISTRATION_NUMBER } },
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
    const typedRows = rows as (RawOrgWithGeo & {
      users: { name: string; email: string }[];
      _count: { users: number; studies: number; surveys: number; reports: number };
    })[];

    // Separate groupBy, not a second `_count.select` entry: Prisma's filtered
    // relation count reuses the relation's own field name as the result key
    // (there's no way to alias `reports` twice — once filtered, once not —
    // in a single `_count.select`), so "published" (released or archived —
    // ReportStatus has no `published` value of its own) has to be counted
    // separately and merged in.
    const publishedCounts = await this.tenant.runAsSupervisor((tx) =>
      tx.report.groupBy({
        by: ['orgId'],
        where: { orgId: { in: typedRows.map((r) => r.id) }, status: { in: ['released', 'archived'] } },
        _count: { _all: true },
      }),
    );
    const publishedByOrgId = new Map(publishedCounts.map((p) => [p.orgId, p._count._all]));

    // SurveyResponse carries orgId directly (see its schema comment), so no
    // join is needed — same groupBy-and-merge shape as publishedCounts above.
    const responseCounts = await this.tenant.runAsSupervisor((tx) =>
      tx.surveyResponse.groupBy({
        by: ['orgId'],
        where: { orgId: { in: typedRows.map((r) => r.id) } },
        _count: { _all: true },
      }),
    );
    const responseCountByOrgId = new Map(responseCounts.map((p) => [p.orgId, p._count._all]));

    return typedRows.map((r) => ({
      ...this.toOrganization(this.toOrgRow(r)),
      memberCount: r._count.users,
      studyCount: r._count.studies,
      surveyCount: r._count.surveys,
      reportCount: r._count.reports,
      publishedReportCount: publishedByOrgId.get(r.id) ?? 0,
      responseCount: responseCountByOrgId.get(r.id) ?? 0,
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

  // Mirrors AuthService.resolveSignupConsents — both consents are required
  // together and checked against the *currently* active policy version, so
  // a System Admin whose dialog was left open across a policy update gets
  // the same CONSENT_VERSION_STALE rejection self-signup would.
  private async resolveOrgAdminConsents(
    consent: CreateOrganizationPayload['consent'],
  ): Promise<ConsentAcceptanceInput[]> {
    if (!consent) {
      throw new BadRequestException({
        error: {
          code: 'CONSENT_REQUIRED',
          message: 'Use Policy and Data Sharing consent are required to create an NGO Admin.',
        },
      });
    }
    const requestedLocale = consent.locale ?? DEFAULT_CONSENT_LOCALE;
    const submitted: Array<{ kind: ConsentPolicyKind; version: string }> = [
      { kind: ConsentPolicyKind.use_policy, version: consent.usePolicyVersion },
      { kind: ConsentPolicyKind.data_sharing, version: consent.dataSharingVersion },
    ];
    return Promise.all(
      submitted.map(async ({ kind, version }) => {
        const active = await this.consentPolicies.getActivePolicy(kind);
        if (active.version !== version) {
          throw new BadRequestException({
            error: {
              code: 'CONSENT_VERSION_STALE',
              message:
                'The consent policy was updated while this form was open. Please review the current version and try again.',
              details: { kind, submittedVersion: version, currentVersion: active.version },
            },
          });
        }
        return {
          kind,
          version: active.version,
          text: consentPolicyTextFor(active, requestedLocale),
          locale: resolveConsentLocale(active, requestedLocale),
        };
      }),
    );
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
