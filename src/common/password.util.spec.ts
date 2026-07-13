import { generateTemporaryPassword, hashPassword, verifyPassword } from './password.util';

describe('password.util', () => {
  it('hashes a password and verifies it round-trips', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).not.toBe('correct-horse-battery-staple');
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects the wrong password against a hash', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same-input');
    const b = await hashPassword('same-input');
    expect(a).not.toBe(b);
  });
});

describe('generateTemporaryPassword', () => {
  it('generates a non-trivial, URL-safe string', () => {
    const password = generateTemporaryPassword();
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a different password each call', () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).not.toBe(b);
  });

  it('round-trips through hashPassword/verifyPassword like any other password', async () => {
    const password = generateTemporaryPassword();
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });
});
