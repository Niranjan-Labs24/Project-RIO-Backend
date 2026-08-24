import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// RIO-NFR-002 / AD-17 — AES-256-GCM (authenticated) for the recoverable value,
// random IV per encryption (no longer deterministic). Equality/dedup is served
// by a SEPARATE keyed blind index (see computeBlindIndex), so this no longer
// needs to be deterministic. Format: "gcm.v1:<iv-hex>:<tag-hex>:<ct-hex>".
const ALGORITHM = 'aes-256-gcm' as const;
const IV_BYTES = 12;
const SCHEME = 'gcm.v1';

/** Decode a base64 key to exactly 32 bytes, or throw. */
export function decodeKey(keyB64: string): Buffer {
  const buf = Buffer.from(keyB64, 'base64');
  if (buf.length !== 32) {
    throw new Error(`Key must base64-decode to exactly 32 bytes (got ${buf.length})`);
  }
  return buf;
}

export function encryptPii(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SCHEME}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptPii(value: string, keyB64: string): string {
  if (!isEncrypted(value)) return value; // redacted:<id> / legacy plaintext pass through
  const parts = value.split(':');
  const ivHex = parts[1] as string;
  const tagHex = parts[2] as string;
  const ctHex = parts[3] as string;
  const decipher = createDecipheriv(ALGORITHM, decodeKey(keyB64), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex')); // throws on tamper in final()
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
}

export function isEncrypted(value: string): boolean {
  return /^gcm\.v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}

/**
 * Keyed blind index for equality lookups / uniqueness on encrypted fields.
 * HMAC-SHA256(indexKey, normalizedValue) → 64 hex chars. MUST use a key
 * distinct from the encryption key, and MUST be fed the normalized form.
 */
export function computeBlindIndex(normalizedValue: string, indexKeyB64: string): string {
  return createHmac('sha256', decodeKey(indexKeyB64)).update(normalizedValue).digest('hex');
}
