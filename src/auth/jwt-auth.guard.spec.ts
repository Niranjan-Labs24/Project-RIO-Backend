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

function makeGuard(isPublic = false, user: object | null = {
  orgId: 'o1', roleId: 'role_ngo_admin', org: { isActive: true },
}) {
  const reflector = { getAllAndOverride: () => isPublic } as never;
  const tenant = {
    runAsSupervisor: (fn: (tx: object) => unknown) => fn({ user: { findUnique: () => Promise.resolve(user) } }),
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
});
