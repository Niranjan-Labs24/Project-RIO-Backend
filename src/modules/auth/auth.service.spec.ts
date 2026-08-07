import { vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { PERMISSION_MODULES } from '../../rbac/role-matrix';
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
const domainsStub = {
  listDomains: async () => [{ id: 'd1', code: 'W', name: 'Water & Sanitation', isActive: true }],
};
const geographyStub = { validateHierarchy: vi.fn().mockResolvedValue(undefined) };

// RIO-DATA-001 — the two separately-versioned consents AuthService resolves
// during signup and the post-login re-prompt. Both are seeded at 'v1' here so
// a signup fixture that submits 'v1' for each passes the active-version check.
const USE_POLICY = { kind: 'use_policy' as const, version: 'v1', text: 'policy text' };
const SHARING_POLICY = { kind: 'data_sharing' as const, version: 'v1', text: 'sharing text' };
const consentStub = {
  getActivePolicy: vi.fn(async (kind: 'use_policy' | 'data_sharing') =>
    kind === 'use_policy' ? USE_POLICY : SHARING_POLICY,
  ),
  getActivePolicies: vi.fn(async () => ({ usePolicy: USE_POLICY, dataSharing: SHARING_POLICY })),
};
/** Both consents accepted at their active versions — the happy-path signup body. */
const VALID_CONSENT = { usePolicyVersion: 'v1', dataSharingVersion: 'v1' };

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
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    const session = await svc.login('admin@demo-ngo.org', 'Passw0rd!');
    expect(session.token).toBeTruthy();
    expect(tokens.verify(session.token).sub).toBe('u1');
    expect(session.user.email).toBe('admin@demo-ngo.org');
    expect(session.organization.name).toBe('Demo NGO');
    expect(session.role.key).toBe('ngo_admin');
    expect(session.role.permissions).toHaveLength(PERMISSION_MODULES.length);
    expect(session.mustChangePassword).toBe(false);
    expect(session.organization.purpose).toBe('Water access');
    expect(session.organization.registrationNumber).toBe('RN-001');
  });

  it('throws 401 on a wrong password', async () => {
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    await expect(svc.login('admin@demo-ngo.org', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when the user does not exist', async () => {
    const svc = new AuthService(fakeTenant(null) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    await expect(svc.login('nobody@x.org', 'whatever')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses valid credentials when the org is deactivated (403 ORG_INACTIVE)', async () => {
    const inactive = { ...user, org: { ...orgFixture, isActive: false } };
    const svc = new AuthService(fakeTenant(inactive) as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    await expect(svc.login('admin@demo-ngo.org', 'Passw0rd!')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService.consent', () => {
  // RIO-DATA-001 — the post-login re-prompt now accepts BOTH consents in one
  // call and writes one immutable snapshot per kind, so the two remain
  // independently auditable.
  function consentTenant() {
    const created: Record<string, unknown>[] = [];
    const userUpdates: Record<string, unknown>[] = [];
    const tenant = {
      runInOrgContext: async (fn: (tx: unknown) => unknown) =>
        fn({
          user: { update: async ({ data }: { data: Record<string, unknown> }) => { userUpdates.push(data); return {}; } },
          consentAcceptance: {
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => { created.push(...data); return { count: data.length }; },
          },
        }),
    };
    return { tenant, created, userUpdates };
  }

  it('stamps both consent pairs on the user and snapshots each policy separately', async () => {
    const { tenant, created, userUpdates } = consentTenant();
    const svc = new AuthService(tenant as never, passwords, tokens, auditStub as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    const res = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () => svc.consent());

    expect(res.policyVersion).toBe('v1');
    expect(res.sharingPolicyVersion).toBe('v1');
    // One row per kind — not one combined acceptance.
    expect(created).toHaveLength(2);
    expect(created).toContainEqual(
      expect.objectContaining({ orgId: 'o1', userId: 'u1', kind: 'use_policy', policyVersion: 'v1', policyText: 'policy text' }),
    );
    expect(created).toContainEqual(
      expect.objectContaining({ orgId: 'o1', userId: 'u1', kind: 'data_sharing', policyVersion: 'v1', policyText: 'sharing text' }),
    );
    // Both denormalized pairs move together on this path.
    expect(userUpdates[0]).toMatchObject({
      consentedPolicyVersion: 'v1',
      sharingConsentedPolicyVersion: 'v1',
    });
    expect(userUpdates[0]?.consentedAt).toBeInstanceOf(Date);
    expect(userUpdates[0]?.sharingConsentedAt).toBeInstanceOf(Date);
  });

  it('records a separate audit event per consent kind', async () => {
    const { tenant } = consentTenant();
    const audit = { record: vi.fn() };
    const svc = new AuthService(tenant as never, passwords, tokens, audit as never, repoStub as never, mailerStub as never, configStub, domainsStub as never, geographyStub as never, consentStub as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () => svc.consent());

    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent', entityLabel: 'Accepted use policy v1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent', entityLabel: 'Accepted data-sharing consent v1' }),
    );
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
    service = new AuthService(tenant as never, passwords as never, tokens as never, audit as never, repo as never, mailer as never, config, domainsStub as never, geographyStub as never, consentStub as never);
  });

  it('signup: creates org+admin, records audit, returns emailed=true when mailer succeeds', async () => {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(true);

    const res = await service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'], consent: VALID_CONSENT });

    expect(res.temporaryPasswordEmailed).toBe(true);
    expect(res.temporaryPassword).toBeUndefined();
    expect(res.mustChangePassword).toBe(true);
    expect(res.organization.registrationNumber).toBe('RN1');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'organization' }));
  });

  it('signup: rejects a duplicate registration number before creating', async () => {
    repo.findByRegistrationNumber.mockResolvedValue({ id: 'existing' });
    await expect(service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'], consent: VALID_CONSENT }))
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
    const res = await service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'], consent: VALID_CONSENT });
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
    const prodService = new AuthService(tenant as never, passwords as never, tokens as never, audit as never, repo as never, mailer as never, prodConfig, domainsStub as never, geographyStub as never, consentStub as never);

    const res = await prodService.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'], consent: VALID_CONSENT });

    expect(res.temporaryPasswordEmailed).toBe(false);
    expect(res.temporaryPassword).toBeUndefined();
  });

  it('signup: never logs the temporary password, even when revealing it in the response (Task 10)', async () => {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: null, consentedPolicyVersion: null, failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(false);
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const res = await service.signup({ organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test', regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'], consent: VALID_CONSENT });

    expect(typeof res.temporaryPassword).toBe('string');
    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String);
    expect(allLoggedArgs.some((arg) => arg.includes(res.temporaryPassword as string))).toBe(false);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── RIO-DATA-001: consent is part of registration ──────────────────────
  //
  // The point of moving consent into signup is that an organisation can
  // never exist without both acceptances on record. These pin that: the
  // versions reach the repository resolved (with policy text), and anything
  // that doesn't match the active version stops the registration before a
  // single row is written.

  function stubSuccessfulCreate() {
    repo.findByRegistrationNumber.mockResolvedValue(null);
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createOrganisationAndAdmin.mockResolvedValue({
      org: { id: 'o1', name: 'Org', purpose: 'p', registrationNumber: 'RN1', logoUrl: null, region: [], email: null, sector: null, villages: [], isActive: true, createdAt: new Date() },
      user: { id: 'u1', name: 'Org Admin', email: 'a@b.test', roleId: 'role_ngo_admin', passwordHash: 'h', consentedAt: new Date(), consentedPolicyVersion: 'v1', sharingConsentedAt: new Date(), sharingConsentedPolicyVersion: 'v1', failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    mailer.sendTemporaryPassword.mockResolvedValue(true);
  }

  const signupBody = {
    organizationName: 'Org', purpose: 'p', registrationNumber: 'RN1', email: 'a@b.test',
    regionId: 'r1', governorateIds: ['g1'], centerIds: ['c1'],
  };

  it('passes both consents to the repository resolved with their server-side policy text', async () => {
    stubSuccessfulCreate();

    await service.signup({ ...signupBody, consent: VALID_CONSENT });

    const passed = repo.createOrganisationAndAdmin.mock.calls[0]?.[0]?.consents;
    expect(passed).toHaveLength(2);
    // Text comes from the server's own policy row, never from the client.
    expect(passed).toContainEqual({ kind: 'use_policy', version: 'v1', text: 'policy text' });
    expect(passed).toContainEqual({ kind: 'data_sharing', version: 'v1', text: 'sharing text' });
  });

  it('audits each consent as its own event at registration', async () => {
    stubSuccessfulCreate();

    await service.signup({ ...signupBody, consent: VALID_CONSENT });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent', entityLabel: 'Accepted use policy v1 at registration' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'consent', entityLabel: 'Accepted data-sharing consent v1 at registration' }),
    );
  });

  it.each([
    ['use policy', { usePolicyVersion: 'v0', dataSharingVersion: 'v1' }],
    ['data-sharing consent', { usePolicyVersion: 'v1', dataSharingVersion: 'v0' }],
  ])('rejects a stale %s version and creates nothing', async (_label, consent) => {
    stubSuccessfulCreate();

    await expect(service.signup({ ...signupBody, consent })).rejects.toMatchObject({
      response: { error: { code: 'CONSENT_VERSION_STALE' } },
    });
    // The whole point: no org exists without both consents.
    expect(repo.createOrganisationAndAdmin).not.toHaveBeenCalled();
  });

  it('resolves both consents before any write, not after the org row exists', async () => {
    // Ordering matters as much as the check itself: resolving after the
    // create would leave a half-registered org behind on a stale version.
    stubSuccessfulCreate();

    await service.signup({ ...signupBody, consent: VALID_CONSENT });

    expect(consentStub.getActivePolicy).toHaveBeenCalledWith('use_policy');
    expect(consentStub.getActivePolicy).toHaveBeenCalledWith('data_sharing');
    const resolvedAt = Math.max(
      ...consentStub.getActivePolicy.mock.invocationCallOrder,
    );
    expect(resolvedAt).toBeLessThan(repo.createOrganisationAndAdmin.mock.invocationCallOrder[0]!);
  });

  it('refuses to register at all when a consent kind has no active policy configured', async () => {
    // Server misconfiguration must fail the registration loudly rather than
    // letting an account through with one consent missing.
    stubSuccessfulCreate();
    consentStub.getActivePolicy.mockImplementationOnce(async () => USE_POLICY);
    consentStub.getActivePolicy.mockImplementationOnce(async () => {
      throw new NotFoundException({
        error: { code: 'NO_ACTIVE_CONSENT_POLICY', message: 'No active data-sharing consent policy is configured.' },
      });
    });

    await expect(service.signup({ ...signupBody, consent: VALID_CONSENT })).rejects.toMatchObject({
      response: { error: { code: 'NO_ACTIVE_CONSENT_POLICY' } },
    });
    expect(repo.createOrganisationAndAdmin).not.toHaveBeenCalled();
  });

  it('ignores client-supplied policy text, storing the server\'s own copy', async () => {
    // The client sends versions only; the text written to the immutable
    // acceptance row must come from the policy table, or an attacker could
    // file a consent record against wording they authored.
    stubSuccessfulCreate();

    await service.signup({
      ...signupBody,
      consent: { ...VALID_CONSENT, usePolicyText: 'I agree to nothing' } as never,
    });

    const passed = repo.createOrganisationAndAdmin.mock.calls[0]?.[0]?.consents as Array<{ text: string }>;
    expect(passed.map((c) => c.text)).toEqual(['policy text', 'sharing text']);
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
    service = new AuthService(tenant as never, passwords as never, tokens, audit as never, repo as never, mailer as never, config, domainsStub as never, geographyStub as never, consentStub as never);
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
