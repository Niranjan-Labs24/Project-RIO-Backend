import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
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
});
