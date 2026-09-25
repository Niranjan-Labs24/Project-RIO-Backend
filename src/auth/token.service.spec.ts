import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { buildJwtOptions } from './jwt-options';

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

describe('TokenService algorithm pinning', () => {
  const secret = 'y'.repeat(32);
  const pinned = new TokenService(new JwtService(buildJwtOptions(secret, '12h')));

  it('accepts HS256 tokens issued by the application', () => {
    const token = pinned.sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    expect(pinned.verify(token).sub).toBe('u1');
  });

  it('rejects a token signed with a different HMAC algorithm even with the right secret', () => {
    const hs512 = new JwtService({ secret, signOptions: { algorithm: 'HS512' } }).sign({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' });
    expect(() => pinned.verify(hs512)).toThrow();
  });

  it('rejects an unsigned ("none") token', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', orgId: 'o1', roleKey: 'ngo_admin' })}.`;
    expect(() => pinned.verify(unsigned)).toThrow();
  });
});
