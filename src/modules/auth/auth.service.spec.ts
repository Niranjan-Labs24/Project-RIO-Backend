import { vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { AuthService } from './auth.service';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';
import type { ConfigService } from '../../config/config.service';

const passwords = new PasswordService();
const tokens = new TokenService(new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } }));
const auditStub = { record: async () => {} };

// Task 6 additions: AuthRepository/MailerService/ConfigService mocks used by
// signup(). login/me/logout/consent tests don't exercise these, so a bare
// stub repo (never called) is enough for the constructor's widened arity.
const repoStub = { findByRegistrationNumber: vi.fn(), findUserByEmail: vi.fn(), createOrganisationAndAdmin: vi.fn() };
const mailerStub = { sendTemporaryPassword: vi.fn() };
const configStub = { nodeEnv: 'development' } as unknown as ConfigService;

const orgFixture = {
  id: 'o1', name: 'Demo NGO', logoUrl: null, region: ['North'], email: 'admin@demo-ngo.org',
  sector: 'wash', villages: ['A'], isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
  purpose: 'Water access', registrationNumber: 'RN-001',
};

function fakeTenant(user: unknown) {
  return {
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn({ user: { findUnique: async () => user } }),
    runAsOrg: async (_o: string, fn: (tx: unknown) => unknown) => fn({ user: { update: async () => ({}) } }),
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn({ user: { update: async () => ({}), findUnique: async () => user } }),
  };
}

describe('AuthService.login', () => {
  let user: Record<string, unknown>;

  beforeAll(async () => {
    const passwordHash = await passwords.hash('Passw0rd!');
    user = {
      id: 'u1', name: 'Demo Admin', email: 'admin@demo-ngo.org', roleId: 'role_ngo_admin',
      passwordHash, consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null,
      mustChangePassword: false, org: orgFixture,
    };
  });

  it('returns a SessionContext with token, user, org and role on valid credentials', async () => {
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub);
    const session = await svc.login('admin@demo-ngo.org', 'Passw0rd!');
    expect(session.token).toBeTruthy();
    expect(tokens.verify(session.token).sub).toBe('u1');
    expect(session.user.email).toBe('admin@demo-ngo.org');
    expect(session.organization.name).toBe('Demo NGO');
    expect(session.role.key).toBe('ngo_admin');
    expect(session.role.permissions).toHaveLength(12);
    expect(session.mustChangePassword).toBe(false);
    expect(session.organization.purpose).toBe('Water access');
    expect(session.organization.registrationNumber).toBe('RN-001');
  });

  it('throws 401 on a wrong password', async () => {
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub);
    await expect(svc.login('admin@demo-ngo.org', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when the user does not exist', async () => {
    const svc = new AuthService(fakeTenant(null) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub);
    await expect(svc.login('nobody@x.org', 'whatever')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses valid credentials when the org is deactivated (403 ORG_INACTIVE)', async () => {
    const inactive = { ...user, org: { ...orgFixture, isActive: false } };
    const svc = new AuthService(fakeTenant(inactive) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub);
    await expect(svc.login('admin@demo-ngo.org', 'Passw0rd!')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService.consent', () => {
  it('sets consentedAt + consentedPolicyVersion and writes a versioned consent_acceptances snapshot', async () => {
    const created: Record<string, unknown>[] = [];
    const userUpdates: Record<string, unknown>[] = [];
    const tenant = {
      runInOrgContext: async (fn: (tx: unknown) => unknown) =>
        fn({
          consentPolicy: { findFirst: async () => ({ version: 'v1', text: 'policy text' }) },
          user: { update: async ({ data }: { data: Record<string, unknown> }) => { userUpdates.push(data); return {}; } },
          consentAcceptance: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; } },
        }),
    };
    const svc = new AuthService(tenant as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub);
    const res = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () => svc.consent());
    expect(res.policyVersion).toBe('v1');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ orgId: 'o1', userId: 'u1', policyVersion: 'v1', policyText: 'policy text' });
    expect(userUpdates[0]).toMatchObject({ consentedPolicyVersion: 'v1' });
  });
});

describe('AuthService.signup', () => {
  const tenant = {}; // signup goes through the repo, not the tenant, directly
  const audit = { record: vi.fn() };
  const repo = { findByRegistrationNumber: vi.fn(), findUserByEmail: vi.fn(), createOrganisationAndAdmin: vi.fn() };
  const mailer = { sendTemporaryPassword: vi.fn() };
  const config = { nodeEnv: 'development' } as unknown as ConfigService;

  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AuthService(tenant as never, passwords as never, tokens as never, audit as never, repo as never, mailer as never, config);
  });

  it('signup: creates org+admin, records audit, returns emailed=true when mailer succeeds', async () => {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(true);

    const res = await service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test' });

    expect(res.temporaryPasswordEmailed).toBe(true);
    expect(res.temporaryPassword).toBeUndefined();
    expect(res.mustChangePassword).toBe(true);
    expect(res.organization.registrationNumber).toBe('RN1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'organization' }));
  });

  it('signup: rejects a duplicate registration number before creating', async () => {
    repo.findByRegistrationNumber.mockResolvedValue({ id: 'existing' });
    await expect(service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test' }))
      .rejects.toMatchObject({ response: { error: { code: 'ORGANIZATION_ALREADY_REGISTERED' } } });
    expect(repo.createOrganisationAndAdmin).not.toHaveBeenCalled();
  });

  it('signup: reveals temporaryPassword only outside production when mailer is unconfigured', async () => {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(false);
    // config mock nodeEnv = 'development'
    const res = await service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test' });
    expect(res.temporaryPasswordEmailed).toBe(false);
    expect(typeof res.temporaryPassword).toBe('string');
  });

  it('signup: never leaks temporaryPassword in production, even when the mailer fails to send', async () => {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(false);
    const prodConfig = { nodeEnv: 'production' } as unknown as ConfigService;
    const prodService = new AuthService(tenant as never, passwords as never, tokens as never, audit as never, repo as never, mailer as never, prodConfig);

    const res = await prodService.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test' });

    expect(res.temporaryPasswordEmailed).toBe(false);
    expect(res.temporaryPassword).toBeUndefined();
  });
});

describe('AuthService.changePassword', () => {
  // Local stubs (shadow the file-level `passwords`/`tenant` helpers): this
  // service call needs fine-grained control over verify/hash return values
  // and over what each successive runInOrgContext call resolves to.
  const tenant = { runInOrgContext: vi.fn() };
  const passwords = { verify: vi.fn(), hash: vi.fn() };
  const audit = { record: vi.fn() };
  const repo = { findByRegistrationNumber: vi.fn(), findUserByEmail: vi.fn(), createOrganisationAndAdmin: vi.fn() };
  const mailer = { sendTemporaryPassword: vi.fn() };
  const config = { nodeEnv: 'development' } as unknown as ConfigService;

  let service: AuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new AuthService(tenant as never, passwords as never, tokens, audit as never, repo as never, mailer as never, config);
  });

  it('changePassword: rejects a wrong current password with 401 INVALID_CURRENT_PASSWORD', async () => {
    // requireActor -> 'u1'; runInOrgContext -> returns a user row with passwordHash 'h'
    tenant.runInOrgContext.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique: () => ({ id: 'u1', passwordHash: 'h', roleId: 'role_ngo_admin', org: { id: 'o1', isActive: true } }) } }));
    passwords.verify.mockResolvedValue(false);
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
        service.changePassword({ currentPassword: 'wrong', newPassword: 'newpass123' })),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_CURRENT_PASSWORD' } } });
    // A failed verify must short-circuit before any write: only the initial
    // lookup call to runInOrgContext happened (no second call for the
    // update), and no new password was ever hashed.
    expect(tenant.runInOrgContext).toHaveBeenCalledTimes(1);
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it('changePassword: refuses a correct current password when the org is deactivated (403 ORG_INACTIVE) and does not write', async () => {
    tenant.runInOrgContext.mockImplementationOnce((fn: (tx: unknown) => unknown) =>
      fn({ user: { findUnique: () => ({ id: 'u1', passwordHash: 'h', roleId: 'role_ngo_admin', org: { id: 'o1', isActive: false } }) } }));
    passwords.verify.mockResolvedValue(true);
    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
        service.changePassword({ currentPassword: 'ok', newPassword: 'newpass123' })),
    ).rejects.toMatchObject({ response: { error: { code: 'ORG_INACTIVE' } } });
    // Gated before the write: only the initial lookup call happened (no
    // second call for the update), and no new password was ever hashed.
    expect(tenant.runInOrgContext).toHaveBeenCalledTimes(1);
    expect(passwords.hash).not.toHaveBeenCalled();
  });

  it('changePassword: updates hash, clears mustChangePassword, returns a session', async () => {
    const updateArgs: Record<string, unknown>[] = [];
    tenant.runInOrgContext
      .mockImplementationOnce((fn: (tx: unknown) => unknown) =>
        fn({ user: { findUnique: () => ({ id: 'u1', passwordHash: 'h', roleId: 'role_ngo_admin', org: { id: 'o1', isActive: true } }) } }))
      .mockImplementationOnce((fn: (tx: unknown) => unknown) =>
        fn({
          user: {
            update: (args: Record<string, unknown>) => {
              updateArgs.push(args);
              return {
                id: 'u1', name: 'A', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h2',
                consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: false,
                org: {
                  id: 'o1', name: 'Org', logoUrl: null, region: [], email: null, sector: null, villages: [],
                  isActive: true, createdAt: new Date(), purpose: 'p', registrationNumber: 'RN1',
                },
              };
            },
          },
        }));
    passwords.verify.mockResolvedValue(true);
    passwords.hash.mockResolvedValue('h2');
    const res = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      service.changePassword({ currentPassword: 'ok', newPassword: 'newpass123' }));
    expect(res.mustChangePassword).toBe(false);
    expect(res.user.id).toBe('u1');
    // Verify the actual write: the update call's `data` must clear
    // mustChangePassword and persist the newly hashed password, not just
    // that the (mocked) response happened to say so.
    expect(updateArgs).toHaveLength(1);
    expect(updateArgs[0]).toMatchObject({ data: { mustChangePassword: false, passwordHash: 'h2' } });
  });
});
