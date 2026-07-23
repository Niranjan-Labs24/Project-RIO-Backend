import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserStatus } from '../../generated/prisma';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { ROLE_MATRIX, roleByKey, type RoleDef } from '../../rbac/role-matrix';
import { PasswordService } from '../../auth/password.service';
import { ConfigService } from '../../config/config.service';
import { MailerService } from '../../mailer/mailer.service';
import { generateTemporaryPassword } from '../auth/auth.repository';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type {
  CreateForOrgPayload, InviteUserPayload, InviteUserResponse, OrgUser, UpdateUserPayload, UserRow,
} from './users.types';

const DIFF_FIELDS = ['name', 'roleId', 'status'] as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  async list(opts: { limit?: number; offset?: number } = {}): Promise<OrgUser[]> {
    const { take, skip } = this.page(opts);
    const rows = (await this.tenant.runInOrgContext((tx) => tx.user.findMany({ orderBy: { createdAt: 'asc' }, take, skip }))) as UserRow[];
    return rows.map((r) => this.toOrgUser(r));
  }

  // Same pattern as AuthService.signup(): a user an NGO Admin creates never
  // chooses their own password up front — a temporary one is
  // generated here, hashed, stored, and mustChangePassword is set so the
  // PasswordChangeGuard forces a reset on first login. Emailed if possible;
  // otherwise (no SMTP configured, e.g. local dev) surfaced back to the
  // caller so the admin can hand it to the new user directly.
  async invite(payload: InviteUserPayload): Promise<InviteUserResponse> {
    const role = this.validateRole(payload.roleId);
    const orgId = requireOrgId();
    const { created, orgName } = await this.createUser(() =>
      this.tenant.runInOrgContext(async (tx) => {
        const org = await tx.organisation.findUnique({ where: { id: orgId } });
        const user = await tx.user.create({
          data: { orgId, name: payload.name, email: payload.email, roleId: role.id, status: UserStatus.invited },
        });
        return { created: user, orgName: org?.name ?? '' };
      }),
    );
    await this.audit.record({ action: 'create', entityType: 'user', entityId: created.id, entityLabel: created.email });
    const credentials = await this.provisionTemporaryPassword(created.id, created.email, orgName, orgId);
    return { ...this.toOrgUser(created), ...credentials };
  }

  // Generates + hashes a temporary password, stores it with mustChangePassword
  // set, emails it, and (dev-only, mailer unconfigured) returns it in the
  // clear so the caller can hand it to the new user some other way.
  private async provisionTemporaryPassword(
    userId: string,
    email: string,
    orgName: string,
    orgId: string,
  ): Promise<{ temporaryPasswordEmailed: boolean; temporaryPassword?: string }> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    await this.tenant.runAsOrg(orgId, (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true } }),
    );
    const emailed = await this.mailer.sendTemporaryPassword(email, orgName, temporaryPassword);
    if (emailed) return { temporaryPasswordEmailed: true };
    if (this.config.nodeEnv !== 'production') {
      this.logger.log(`[dev-only] Temporary password for ${email}: ${temporaryPassword}`);
      return { temporaryPasswordEmailed: false, temporaryPassword };
    }
    return { temporaryPasswordEmailed: false };
  }

  async update(id: string, patch: UpdateUserPayload): Promise<OrgUser> {
    if (patch.roleId !== undefined) this.validateRole(patch.roleId);
    const { updated, changes } = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.user.findUnique({ where: { id } })) as UserRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      const changes = this.diff(current, patch);
      const updated = (await tx.user.update({ where: { id }, data: this.buildUpdateData(patch) })) as UserRow;
      return { updated, changes };
    });
    if (changes.length > 0) {
      await this.audit.record({ action: 'edit', entityType: 'user', entityId: updated.id, entityLabel: updated.email, changes });
    }
    return this.toOrgUser(updated);
  }

  async remove(id: string): Promise<void> {
    const actorId = requireActor();
    if (id === actorId) {
      throw new BadRequestException({
        error: { code: 'CANNOT_REMOVE_SELF', message: "You can't remove your own account." },
      });
    }
    const removed = await this.tenant.runInOrgContext(async (tx) => {
      const current = (await tx.user.findUnique({ where: { id } })) as UserRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
      // Privilege guard (mirrors validateRole): only a crossEntity caller may
      // remove a crossEntity account. Otherwise a tenant-scoped admin could
      // delete a platform-wide user (e.g. a system_admin that shares their org
      // via RLS), which the tenant admin has no authority over.
      const targetRole = ROLE_MATRIX.find((r) => r.id === current.roleId);
      if (targetRole?.crossEntity && roleByKey(getOrgStore()?.role ?? '')?.crossEntity !== true) {
        throw new ForbiddenException({
          error: { code: 'FORBIDDEN_USER_REMOVAL', message: 'You are not allowed to remove a cross-entity account' },
        });
      }
      await tx.user.delete({ where: { id } });
      return current;
    });
    await this.audit.record({ action: 'delete', entityType: 'user', entityId: id, entityLabel: removed.email });
  }

  // System-Admin cross-org list.
  async listForOrg(organizationId: string, opts: { limit?: number; offset?: number } = {}): Promise<OrgUser[]> {
    this.assertCrossEntity();
    const { take, skip } = this.page(opts);
    const rows = (await this.tenant.runAsSupervisor((tx) =>
      tx.user.findMany({ where: { orgId: organizationId }, orderBy: { createdAt: 'asc' }, take, skip }),
    )) as UserRow[];
    return rows.map((r) => this.toOrgUser(r));
  }

  // System-Admin cross-org invite.
  async createForOrg(payload: CreateForOrgPayload): Promise<InviteUserResponse> {
    this.assertCrossEntity();
    const role = this.validateRole(payload.roleId);
    const { created, orgName } = await this.createUser(() =>
      this.tenant.runAsOrg(payload.organizationId, async (tx) => {
        const org = await tx.organisation.findUnique({ where: { id: payload.organizationId } });
        const user = await tx.user.create({
          data: { orgId: payload.organizationId, name: payload.name, email: payload.email, roleId: role.id, status: UserStatus.invited },
        });
        return { created: user, orgName: org?.name ?? '' };
      }),
    );
    // Attribute the audit event to the affected org, not the acting admin's org.
    await this.audit.record({ action: 'create', entityType: 'user', entityId: created.id, entityLabel: created.email, organizationId: payload.organizationId });
    const credentials = await this.provisionTemporaryPassword(created.id, created.email, orgName, payload.organizationId);
    return { ...this.toOrgUser(created), ...credentials };
  }

  // Bounded pagination (NFR-006): default 100, hard cap 200.
  private page(opts: { limit?: number; offset?: number }): { take: number; skip: number } {
    return { take: Math.min(Math.max(opts.limit ?? 100, 1), 200), skip: Math.max(opts.offset ?? 0, 0) };
  }

  private assertCrossEntity(): void {
    const roleKey = getOrgStore()?.role;
    if (!roleKey || roleByKey(roleKey)?.crossEntity !== true) {
      throw new ForbiddenException({ error: { code: 'FORBIDDEN', message: 'Cross-entity access required' } });
    }
  }

  private validateRole(roleId: string): RoleDef {
    const role = ROLE_MATRIX.find((r) => r.id === roleId);
    if (!role || role.key === 'citizen_guest') {
      throw new BadRequestException({ error: { code: 'INVALID_ROLE', message: 'roleId is not a valid assignable role' } });
    }
    // Privilege-escalation guard: only a crossEntity caller (e.g. system_admin)
    // may grant a crossEntity role. Without this a tenant-scoped admin
    // (ngo_admin) could mint a platform-wide account and read/write across every
    // organization, defeating tenant isolation.
    if (role.crossEntity) {
      const callerRole = roleByKey(getOrgStore()?.role ?? '');
      if (callerRole?.crossEntity !== true) {
        throw new ForbiddenException({
          error: { code: 'FORBIDDEN_ROLE_ASSIGNMENT', message: 'You are not allowed to assign a cross-entity role' },
        });
      }
    }
    return role;
  }

  // Runs a user-creating transaction, translating a duplicate-email unique
  // violation into a clean 409 (instead of a leaked 500) so a globally-unique
  // email collision is reported as a conflict, not an internal error.
  private async createUser<T>(create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ error: { code: 'EMAIL_TAKEN', message: 'A user with this email already exists' } });
      }
      throw e;
    }
  }

  private buildUpdateData(patch: UpdateUserPayload): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.roleId !== undefined) data.roleId = patch.roleId;
    if (patch.status !== undefined) data.status = patch.status as UserStatus;
    if (patch.roleId !== undefined || patch.status !== undefined) data.sessionVersion = { increment: 1 };
    return data;
  }

  private diff(current: UserRow, patch: UpdateUserPayload): AuditChange[] {
    const before = current as unknown as Record<string, unknown>;
    const after = patch as unknown as Record<string, unknown>;
    const changes: AuditChange[] = [];
    for (const f of DIFF_FIELDS) {
      if (after[f] !== undefined && before[f] !== after[f]) {
        changes.push({ field: f, before: before[f], after: after[f] });
      }
    }
    return changes;
  }

  private toOrgUser(row: UserRow): OrgUser {
    const role = ROLE_MATRIX.find((r) => r.id === row.roleId);
    return {
      id: row.id, name: row.name, email: row.email,
      role: role ? { id: role.id, key: role.key, name: role.name } : { id: row.roleId, key: 'unknown', name: 'Unknown' },
      status: row.status, createdAt: row.createdAt.toISOString(),
    };
  }
}
