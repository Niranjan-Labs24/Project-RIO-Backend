import { describe, expect, it } from 'vitest';
import { encryptPii, decryptPii, computeBlindIndex, decodeKey, isEncrypted } from './citizen-pii.crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');       // valid 32-byte base64
const IDX = Buffer.alloc(32, 9).toString('base64');       // distinct index key

describe('citizen PII crypto (GAP-03)', () => {
  it('GCM round-trips', () => {
    const ct = encryptPii('a@b.co', KEY);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('a@b.co');
    expect(decryptPii(ct, KEY)).toBe('a@b.co');
  });
  it('is non-deterministic (random IV)', () => {
    expect(encryptPii('a@b.co', KEY)).not.toBe(encryptPii('a@b.co', KEY));
  });
  it('detects tampering via the auth tag', () => {
    const ct = encryptPii('a@b.co', KEY);
    const parts = ct.split(':'); // scheme:iv:tag:ct — flip last hex char of ciphertext
    const lastPart = parts[3] as string;
    parts[3] = lastPart.slice(0, -1) + (lastPart.slice(-1) === '0' ? '1' : '0');
    expect(() => decryptPii(parts.join(':'), KEY)).toThrow();
  });
  it('rejects a key that does not decode to exactly 32 bytes', () => {
    expect(() => decodeKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
  it('passes non-ciphertext through unchanged (redacted / plaintext)', () => {
    expect(decryptPii('redacted:abc', KEY)).toBe('redacted:abc');
    expect(isEncrypted('redacted:abc')).toBe(false);
  });
  it('blind index is deterministic, input-sensitive, and key-separated', () => {
    expect(computeBlindIndex('a@b.co', IDX)).toBe(computeBlindIndex('a@b.co', IDX));
    expect(computeBlindIndex('a@b.co', IDX)).not.toBe(computeBlindIndex('x@y.co', IDX));
    expect(computeBlindIndex('a@b.co', IDX)).not.toBe(computeBlindIndex('a@b.co', KEY)); // different key ⇒ different index
    expect(computeBlindIndex('a@b.co', IDX)).toMatch(/^[0-9a-f]{64}$/);
  });
});
