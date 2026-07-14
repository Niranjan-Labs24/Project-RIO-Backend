import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor, requireOrgId } from '../../tenancy/org-context';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';
import { ROLE_MATRIX, type RoleDef } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../../config/config.service';
import { MailerService } from '../../mailer/mailer.service';
import { AuthRepository, conflictFor, generateTemporaryPassword } from './auth.repository';
import type { SessionContext, SessionOrg, SessionUser, SignupResponseView } from './session.types';
import type { ChangePasswordDto, SignupDto } from './auth.contract';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

// The subset of a user row (with its org) this service reads.
interface UserWithOrg {
  id: string;
  name: string;
  email: string;
  roleId: string;
  passwordHash: string | null;
  consentedAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  org: {
    id: string; name: string; logoUrl: string | null; region: string | null;
    email: string | null; sector: string | null; villages: string[]; isActive: boolean; createdAt: Date;
    purpose: string | null; registrationNumber: string | null;
  };
}

// NOTE on session revocation: auth is stateless JWT (JWT_EXPIRES_IN, default
// 12h) with no server-side denylist. Login and me() re-check org.isActive and
// re-read the role from the DB, but a token already in a client's hands stays
// valid until it expires even if the user's role/status or the org changes.
// Full revocation (short-lived access tokens + refresh, or a token/jti denylist)
// is deferred; keep JWT_EXPIRES_IN short in security-sensitive deployments.
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly repo: AuthRepository,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string): Promise<SessionContext> {
    const found = (await this.tenant.runAsSupervisor((tx) =>
      tx.user.findUnique({ where: { email }, include: { org: true } }),
    )) as UserWithOrg | null;

    if (!found || !found.passwordHash) {
      // Burn a comparable amount of CPU as a real verify so an attacker cannot
      // distinguish "no such user" from "wrong password" by response time.
      await this.passwords.verifyDummy(password);
      throw new UnauthorizedException({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }
    if (found.lockedUntil && found.lockedUntil.getTime() > Date.now()) {
      throw new HttpException(
        { error: { code: 'ACCOUNT_LOCKED', message: 'Account is temporarily locked. Try again later.' } },
        HttpStatus.LOCKED,
      );
    }

    const ok = await this.passwords.verify(found.passwordHash, password);
    if (!ok) {
      const attempts = found.failedLoginAttempts + 1;
      const lockedUntil = attempts >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
      await this.tenant.runAsOrg(found.org.id, (tx) =>
        tx.user.update({ where: { id: found.id }, data: { failedLoginAttempts: attempts, lockedUntil } }),
      );
      throw new UnauthorizedException({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    // Credentials are valid — but a deactivated org must not yield a session.
    // (Checked post-verification so org state is never revealed to an
    // unauthenticated caller.)
    if (!found.org.isActive) {
      throw new ForbiddenException({ error: { code: 'ORG_INACTIVE', message: 'This organization is not active' } });
    }

    await this.tenant.runAsOrg(found.org.id, (tx) =>
      tx.user.update({ where: { id: found.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } }),
    );

    const role = this.roleOf(found.roleId);
    // Populate the request store with the now-authenticated identity so the
    // audit write (and any later work in this request) has an org context.
    const store = getOrgStore();
    if (store) {
      store.orgId = found.org.id;
      store.actorId = found.id;
      store.role = role.key;
    }
    await this.audit.record({ action: 'login', entityType: 'user', entityId: found.id, entityLabel: found.email });

    const token = this.tokens.sign({ sub: found.id, orgId: found.org.id, roleKey: role.key });
    return this.buildSession(found, role, token);
  }

  async me(): Promise<SessionContext> {
    const actorId = requireActor();
    const found = (await this.tenant.runInOrgContext((tx) =>
      tx.user.findUnique({ where: { id: actorId }, include: { org: true } }),
    )) as UserWithOrg | null;
    if (!found) {
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    }
    // Stop refreshing a session (and re-issuing a token) once the org is
    // deactivated. NOTE: this does not revoke an already-issued token before it
    // expires — stateless JWTs have no server-side revocation yet (see below).
    if (!found.org.isActive) {
      throw new ForbiddenException({ error: { code: 'ORG_INACTIVE', message: 'This organization is not active' } });
    }
    const role = this.roleOf(found.roleId);
    const token = this.tokens.sign({ sub: found.id, orgId: found.org.id, roleKey: role.key });
    return this.buildSession(found, role, token);
  }

  async logout(): Promise<void> {
    const actorId = requireActor(); // 401 if not authenticated; stateless — client drops the token
    await this.audit.record({ action: 'logout', entityType: 'user', entityId: actorId, entityLabel: actorId });
  }

  async consent(): Promise<{ consentedAt: string; policyVersion: string | null }> {
    const actorId = requireActor();
    const orgId = requireOrgId();
    const now = new Date();
    const policyVersion = await this.tenant.runInOrgContext(async (tx) => {
      const policy = await tx.consentPolicy.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
      await tx.user.update({ where: { id: actorId }, data: { consentedAt: now } });
      // Snapshot the versioned policy the user accepted (immutable acceptance record).
      if (policy) {
        await tx.consentAcceptance.create({
          data: { orgId, userId: actorId, policyVersion: policy.version, policyText: policy.text, acceptedAt: now },
        });
      }
      return policy?.version ?? null;
    });
    return { consentedAt: now.toISOString(), policyVersion };
  }

  // Public NGO signup: creates the organisation + its first NGO Admin (RLS via
  // runAsOrg inside the repository), records consent, and issues a session —
  // same shape login() returns, plus how the temp password was delivered.
  async signup(dto: SignupDto): Promise<SignupResponseView> {
    // Friendly pre-checks (the DB unique constraint is still the source of
    // truth, handled inside the repository for the concurrent-signup race —
    // hence the duplicated error envelopes via the shared conflictFor()).
    if (await this.repo.findByRegistrationNumber(dto.registrationNumber)) {
      throw conflictFor('registrationNumber');
    }
    if (await this.repo.findUserByEmail(dto.email)) {
      throw conflictFor('email');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const now = new Date();

    const { org, user } = await this.repo.createOrganisationAndAdmin({
      organizationName: dto.organizationName,
      purpose: dto.purpose,
      registrationNumber: dto.registrationNumber,
      email: dto.email,
      passwordHash,
      now,
    });

    const role = this.roleOf(user.roleId);
    const store = getOrgStore();
    if (store) {
      store.orgId = org.id;
      store.actorId = user.id;
      store.role = role.key;
    }
    await this.audit.record({ action: 'create', entityType: 'organization', entityId: org.id, entityLabel: org.name, organizationId: org.id });

    const token = this.tokens.sign({ sub: user.id, orgId: org.id, roleKey: role.key });
    const session = this.buildSession({ ...user, org } as never, role, token);

    const emailed = await this.mailer.sendTemporaryPassword(user.email, org.name, temporaryPassword);
    if (emailed) {
      return { ...session, temporaryPasswordEmailed: true };
    }
    if (this.config.nodeEnv !== 'production') {
      this.logger.log(`[dev-only] Temporary password for ${user.email}: ${temporaryPassword}`);
      return { ...session, temporaryPasswordEmailed: false, temporaryPassword };
    }
    return { ...session, temporaryPasswordEmailed: false };
  }

  // Signed-in user replaces a signup-issued temporary password with one they
  // choose, clearing mustChangePassword. Authenticated via requireActor()
  // (no module permission needed — any logged-in user may change their own
  // password); the current-password check gates the write via RLS.
  async changePassword(dto: ChangePasswordDto): Promise<SessionContext> {
    const actorId = requireActor();
    const found = (await this.tenant.runInOrgContext((tx) =>
      tx.user.findUnique({ where: { id: actorId }, include: { org: true } }),
    )) as UserWithOrg | null;
    if (!found || !found.passwordHash) {
      throw new UnauthorizedException({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    }
    if (!(await this.passwords.verify(found.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect' } });
    }
    // Mirror login()/me(): a deactivated org must not get a re-issued session,
    // even mid change-password (checked post-verification, same rationale).
    if (!found.org.isActive) {
      throw new ForbiddenException({ error: { code: 'ORG_INACTIVE', message: 'This organization is not active' } });
    }
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const updated = (await this.tenant.runInOrgContext((tx) =>
      tx.user.update({ where: { id: actorId }, data: { passwordHash, mustChangePassword: false }, include: { org: true } }),
    )) as UserWithOrg;
    const role = this.roleOf(updated.roleId);
    const token = this.tokens.sign({ sub: updated.id, orgId: updated.org.id, roleKey: role.key });
    return this.buildSession(updated, role, token);
  }

  private roleOf(roleId: string): RoleDef {
    const role = ROLE_MATRIX.find((r) => r.id === roleId);
    if (!role) {
      throw new UnauthorizedException({ error: { code: 'INVALID_ROLE', message: 'User role is not recognised' } });
    }
    return role;
  }

  private buildSession(u: UserWithOrg, role: RoleDef, token: string): SessionContext {
    const user: SessionUser = {
      id: u.id, name: u.name, email: u.email,
      consentedAt: u.consentedAt ? u.consentedAt.toISOString() : null,
    };
    const organization: SessionOrg = {
      id: u.org.id, name: u.org.name, logoUrl: u.org.logoUrl, region: u.org.region,
      email: u.org.email, sector: u.org.sector, villages: u.org.villages,
      isActive: u.org.isActive, createdAt: u.org.createdAt.toISOString(),
      purpose: u.org.purpose, registrationNumber: u.org.registrationNumber,
    };
    return { token, user, organization, role, mustChangePassword: u.mustChangePassword };
  }
}
