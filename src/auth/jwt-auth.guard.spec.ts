import { JwtService } from '@nestjs/jwt';
import { orgContext } from '../tenancy/org-context';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

const jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } });
const tokens = new TokenService(jwt);

function makeContext(req: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const request = { headers: req.headers ?? {}, cookies: req.cookies ?? {} };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
}

function makeGuard(
  isPublic = false,
  user: object | null = { orgId: 'o1', roleId: 'role_ngo_admin', sessionVersion: 0, org: { isActive: true } },
  organisation: { isActive: boolean } | null = { isActive: true },
) {
  const reflector = { getAllAndOverride: () => isPublic } as never;
  const tenant = {
    runAsSupervisor: (fn: (tx: object) => unknown) =>
      fn({
        user: { findUnique: () => Promise.resolve(user) },
        organisation: { findUnique: () => Promise.resolve(organisation) },
      }),
  } as never;
  return new JwtAuthGuard(tokens, reflector, tenant);
}

describe('JwtAuthGuard', () => {
  it('allows an explicitly public route without a token', async () => {
    await orgContext.run({ requestId: 'r' }, async () => {
      await expect(makeGuard(true).canActivate(makeContext())).resolves.toBe(true);
    });
  });

  it('rejects a protected route without a token', async () => {
    await orgContext.run({ requestId: 'r' }, async () => {
      await expect(makeGuard().canActivate(makeContext())).rejects.toThrow();
    });
  });

  it('populates current database identity from a valid token', async () => {
    const token = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'center_supervisor' });
    await orgContext.run({ requestId: 'r' }, async () => {
      await expect(makeGuard().canActivate(makeContext({ headers: { authorization: `Bearer ${token}` } }))).resolves.toBe(true);
      expect(orgContext.getStore()).toMatchObject({ actorId: 'u1', orgId: 'o1', role: 'ngo_admin' });
    });
  });

  it('rejects an invalid bearer token', async () => {
    await expect(makeGuard().canActivate(makeContext({ headers: { authorization: 'Bearer bad' } }))).rejects.toThrow();
  });

  it('rejects a token after its user or organization is unavailable', async () => {
    const token = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    await expect(makeGuard(false, null).canActivate(makeContext({ cookies: { rio_session: token } }))).rejects.toThrow();
  });

  it('ignores an invalid stale cookie on a public route', async () => {
    await expect(makeGuard(true).canActivate(makeContext({ cookies: { rio_session: 'bad' } }))).resolves.toBe(true);
  });

  describe('x-act-as-org (crossEntity caller acting on behalf of a chosen org)', () => {
    it('lets a crossEntity role (system_admin) override orgId to a valid active org', async () => {
      const user = { orgId: 'own-org', roleId: 'role_system_admin', sessionVersion: 0, org: { isActive: true } };
      const token = tokens.sign({ sub: 'u1', orgId: 'own-org', roleKey: 'system_admin' });
      await orgContext.run({ requestId: 'r' }, async () => {
        await expect(
          makeGuard(false, user, { isActive: true }).canActivate(
            makeContext({ headers: { authorization: `Bearer ${token}`, 'x-act-as-org': 'target-org' } }),
          ),
        ).resolves.toBe(true);
        expect(orgContext.getStore()).toMatchObject({ orgId: 'target-org', role: 'system_admin' });
      });
    });

    it('ignores the header for a non-crossEntity role (never trusted)', async () => {
      const user = { orgId: 'own-org', roleId: 'role_ngo_admin', sessionVersion: 0, org: { isActive: true } };
      const token = tokens.sign({ sub: 'u1', orgId: 'own-org', roleKey: 'ngo_admin' });
      await orgContext.run({ requestId: 'r' }, async () => {
        await expect(
          makeGuard(false, user, { isActive: true }).canActivate(
            makeContext({ headers: { authorization: `Bearer ${token}`, 'x-act-as-org': 'target-org' } }),
          ),
        ).resolves.toBe(true);
        expect(orgContext.getStore()).toMatchObject({ orgId: 'own-org' });
      });
    });

    it('rejects when the target org does not exist', async () => {
      const user = { orgId: 'own-org', roleId: 'role_system_admin', sessionVersion: 0, org: { isActive: true } };
      const token = tokens.sign({ sub: 'u1', orgId: 'own-org', roleKey: 'system_admin' });
      await orgContext.run({ requestId: 'r' }, async () => {
        await expect(
          makeGuard(false, user, null).canActivate(
            makeContext({ headers: { authorization: `Bearer ${token}`, 'x-act-as-org': 'missing-org' } }),
          ),
        ).rejects.toThrow();
      });
    });

    it('rejects when the target org is inactive', async () => {
      const user = { orgId: 'own-org', roleId: 'role_system_admin', sessionVersion: 0, org: { isActive: true } };
      const token = tokens.sign({ sub: 'u1', orgId: 'own-org', roleKey: 'system_admin' });
      await orgContext.run({ requestId: 'r' }, async () => {
        await expect(
          makeGuard(false, user, { isActive: false }).canActivate(
            makeContext({ headers: { authorization: `Bearer ${token}`, 'x-act-as-org': 'inactive-org' } }),
          ),
        ).rejects.toThrow();
      });
    });
  });
});
