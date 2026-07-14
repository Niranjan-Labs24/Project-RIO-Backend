import { JwtService } from '@nestjs/jwt';
import { orgContext } from '../tenancy/org-context';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

const jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } });
const tokens = new TokenService(jwt);

interface MockRequest {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
}

// Builds a fake ExecutionContext exposing both `headers` and `cookies` on the
// mocked request (cookie-parser populates `cookies` in the real app). Real
// `getOrgStore()` is used (not mocked) — running the assertion inside
// `orgContext.run(store, ...)` makes `getOrgStore()` return that exact store.
function makeContext(req: MockRequest = {}) {
  const request = { headers: req.headers ?? {}, cookies: req.cookies ?? {} };
  return { switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(tokens);

  it('passes through when there is no bearer token (open route / dev seam)', () => {
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(makeContext())).toBe(true);
    });
  });

  it('populates the store from a valid token (Authorization header)', () => {
    const t = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(makeContext({ headers: { authorization: `Bearer ${t}` } }))).toBe(true);
      const s = orgContext.getStore()!;
      expect(s.actorId).toBe('u1');
      expect(s.orgId).toBe('o1');
      expect(s.role).toBe('ngo_admin');
    });
  });

  it('401s on an invalid token', () => {
    orgContext.run({ requestId: 'r' }, () => {
      expect(() => guard.canActivate(makeContext({ headers: { authorization: 'Bearer not.a.jwt' } }))).toThrow();
    });
  });

  it('populates the store from the rio_session cookie when no Authorization header', () => {
    const t = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(makeContext({ cookies: { rio_session: t } }))).toBe(true);
      const s = orgContext.getStore()!;
      expect(s.actorId).toBe('u1');
      expect(s.orgId).toBe('o1');
      expect(s.role).toBe('ngo_admin');
    });
  });

  it('treats an invalid cookie token as anonymous (non-blocking, no 401)', () => {
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(makeContext({ cookies: { rio_session: 'bad' } }))).toBe(true);
      const s = orgContext.getStore()!;
      expect(s.actorId).toBeUndefined();
    });
  });

  it('still hard-401s on an invalid Bearer header even when a cookie is present', () => {
    const t = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    orgContext.run({ requestId: 'r' }, () => {
      expect(() =>
        guard.canActivate(makeContext({ headers: { authorization: 'Bearer bad' }, cookies: { rio_session: t } })),
      ).toThrow();
    });
  });
});
