import { JwtService } from '@nestjs/jwt';
import { orgContext } from '../tenancy/org-context';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenService } from './token.service';

const jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } });
const tokens = new TokenService(jwt);

function ctxWith(auth?: string) {
  const req = { headers: auth ? { authorization: auth } : {} };
  return { switchToHttp: () => ({ getRequest: () => req }) } as never;
}

describe('JwtAuthGuard', () => {
  const guard = new JwtAuthGuard(tokens);

  it('passes through when there is no bearer token (open route / dev seam)', () => {
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(ctxWith())).toBe(true);
    });
  });

  it('populates the store from a valid token', () => {
    const t = tokens.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    orgContext.run({ requestId: 'r' }, () => {
      expect(guard.canActivate(ctxWith(`Bearer ${t}`))).toBe(true);
      const s = orgContext.getStore()!;
      expect(s.actorId).toBe('u1');
      expect(s.orgId).toBe('o1');
      expect(s.role).toBe('ngo_admin');
    });
  });

  it('401s on an invalid token', () => {
    orgContext.run({ requestId: 'r' }, () => {
      expect(() => guard.canActivate(ctxWith('Bearer not.a.jwt'))).toThrow();
    });
  });
});
