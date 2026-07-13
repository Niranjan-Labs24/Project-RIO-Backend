import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { AuthService } from './auth.service';
import { PasswordService } from '../../auth/password.service';
import { TokenService } from '../../auth/token.service';

const passwords = new PasswordService();
const tokens = new TokenService(new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } }));
const auditStub = { record: async () => {} };

const orgFixture = {
  id: 'o1', name: 'Demo NGO', logoUrl: null, region: 'North', email: 'admin@demo-ngo.org',
  sector: 'wash', villages: ['A'], isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
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
      passwordHash, consentedAt: null, failedLoginAttempts: 0, lockedUntil: null, org: orgFixture,
    };
  });

  it('returns a SessionContext with token, user, org and role on valid credentials', async () => {
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never);
    const session = await svc.login('admin@demo-ngo.org', 'Passw0rd!');
    expect(session.token).toBeTruthy();
    expect(tokens.verify(session.token).sub).toBe('u1');
    expect(session.user.email).toBe('admin@demo-ngo.org');
    expect(session.organization.name).toBe('Demo NGO');
    expect(session.role.key).toBe('ngo_admin');
    expect(session.role.permissions).toHaveLength(12);
  });

  it('throws 401 on a wrong password', async () => {
    const svc = new AuthService(fakeTenant(user) as never, passwords, tokens, auditStub as never);
    await expect(svc.login('admin@demo-ngo.org', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws 401 when the user does not exist', async () => {
    const svc = new AuthService(fakeTenant(null) as never, passwords, tokens, auditStub as never);
    await expect(svc.login('nobody@x.org', 'whatever')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses valid credentials when the org is deactivated (403 ORG_INACTIVE)', async () => {
    const inactive = { ...user, org: { ...orgFixture, isActive: false } };
    const svc = new AuthService(fakeTenant(inactive) as never, passwords, tokens, auditStub as never);
    await expect(svc.login('admin@demo-ngo.org', 'Passw0rd!')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('AuthService.consent', () => {
  it('sets consentedAt and writes a versioned consent_acceptances snapshot', async () => {
    const created: Record<string, unknown>[] = [];
    const tenant = {
      runInOrgContext: async (fn: (tx: unknown) => unknown) =>
        fn({
          consentPolicy: { findFirst: async () => ({ version: 'v1', text: 'policy text' }) },
          user: { update: async () => ({}) },
          consentAcceptance: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data; } },
        }),
    };
    const svc = new AuthService(tenant as never, passwords, tokens, auditStub as never);
    const res = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () => svc.consent());
    expect(res.policyVersion).toBe('v1');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ orgId: 'o1', userId: 'u1', policyVersion: 'v1', policyText: 'policy text' });
  });
});
