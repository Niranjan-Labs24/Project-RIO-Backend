import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();
  it('hashes to a non-plaintext argon2id string and verifies round-trip', async () => {
    const hash = await svc.hash('Passw0rd!');
    expect(hash).not.toBe('Passw0rd!');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(hash, 'Passw0rd!')).toBe(true);
    expect(await svc.verify(hash, 'wrong')).toBe(false);
  });

  it('returns false (not throw) when the stored hash is malformed', async () => {
    expect(await svc.verify('not-a-hash', 'whatever')).toBe(false);
  });

  it('verifyDummy always returns false (timing-equaliser for the not-found login path)', async () => {
    expect(await svc.verify('not-a-hash', 'whatever')).toBe(false);
    expect(await svc.verifyDummy('anything')).toBe(false);
    expect(await svc.verifyDummy('anything')).toBe(false); // second call reuses the cached hash
  });
});
