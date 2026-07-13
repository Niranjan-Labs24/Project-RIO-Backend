import { signSessionToken, verifySessionToken } from './session.util';

const SECRET = 'test-only-secret-at-least-32-characters-long';

describe('session.util', () => {
  it('signs and verifies a token round-trip', () => {
    const token = signSessionToken({ sub: 'user_1', orgId: 'org_1', role: 'ngo_admin' }, SECRET);
    const payload = verifySessionToken(token, SECRET);
    expect(payload).toEqual({ sub: 'user_1', orgId: 'org_1', role: 'ngo_admin' });
  });

  it('returns null for a token signed with a different secret', () => {
    const token = signSessionToken({ sub: 'user_1', orgId: 'org_1', role: 'ngo_admin' }, SECRET);
    expect(verifySessionToken(token, 'a-completely-different-secret-value')).toBeNull();
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(verifySessionToken('not-a-jwt', SECRET)).toBeNull();
  });
});
