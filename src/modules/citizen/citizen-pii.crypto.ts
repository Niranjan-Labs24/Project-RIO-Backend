import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

/**
 * RIO-NFR-002 — Deterministic AES-256-CBC encryption for citizen PII fields
 * (SurveyResponse.contact, SurveyResponse.mobile).
 *
 * Deterministic (IV derived via HMAC of the plaintext + key) so that the
 * same contact value always produces the same ciphertext — required for
 * the deduplication query in CitizenService.checkDuplicate(), which
 * compares stored ciphertext against the incoming (re-encrypted) value.
 *
 * Output format: "<iv-hex>:<ciphertext-hex>" stored as TEXT — no Prisma
 * schema type change needed, and the prefix makes it self-describing for
 * future key rotation tooling.
 *
 * Key rotation: re-encrypt all rows with the new key before removing the
 * old one (see ARCHITECTURE.md §Encryption key rotation).
 */

const ALGORITHM = 'aes-256-cbc' as const;
const IV_BYTES = 16;

function deriveIv(plaintext: string, keyBuf: Buffer): Buffer {
  // HMAC-SHA256 of the plaintext with the key → first 16 bytes → IV.
  // Same plaintext + same key → same IV → same ciphertext (deterministic).
  return createHmac('sha256', keyBuf).update(plaintext).digest().subarray(0, IV_BYTES);
}

export function encryptPii(plaintext: string, keyHex: string): string {
  const keyBuf = Buffer.from(keyHex.padEnd(32).slice(0, 32), 'utf8');
  const iv = deriveIv(plaintext, keyBuf);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptPii(ciphertext: string, keyHex: string): string {
  // A plaintext legacy/unencrypted value can validly contain a ":" (e.g. a
  // URL) — check the full "<32-hex-iv>:<hex>" shape via isEncrypted, not
  // just "has a colon", so a plaintext value is passed through unchanged
  // instead of being fed to the decipher and throwing.
  if (!isEncrypted(ciphertext)) return ciphertext;
  const [ivHex, encHex] = ciphertext.split(':') as [string, string];
  const keyBuf = Buffer.from(keyHex.padEnd(32).slice(0, 32), 'utf8');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

/** Returns true if the string looks like an encrypted PII value. */
export function isEncrypted(value: string): boolean {
  return /^[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}
