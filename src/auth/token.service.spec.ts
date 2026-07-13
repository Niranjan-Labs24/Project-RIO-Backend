import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';

const jwt = new JwtService({ secret: 'x'.repeat(32), signOptions: { expiresIn: '12h' } });
const svc = new TokenService(jwt);

describe('TokenService', () => {
  it('signs and verifies claims', () => {
    const token = svc.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    const claims = svc.verify(token);
    expect(claims.sub).toBe('u1');
    expect(claims.orgId).toBe('o1');
    expect(claims.roleKey).toBe('ngo_admin');
  });

  it('throws on a tampered/invalid token', () => {
    expect(() => svc.verify('not.a.jwt')).toThrow();
  });
});
