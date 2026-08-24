import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

// Valid 32-byte base64 keys (GAP-03: both ENCRYPTION_KEY and
// PII_BLIND_INDEX_KEY must decode to exactly 32 bytes) — distinct byte
// patterns so a default-vs-default comparison in validateEnv can't
// accidentally pass. Used as prodEnv()'s defaults so every pre-existing
// case that doesn't care about key validation still passes it.
const DEFAULT_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
const DEFAULT_BLIND_INDEX_KEY = Buffer.alloc(32, 4).toString('base64');
// GAP-02 — same convention, for AUDIT_SIGNING_KEY. Byte 8: distinct from
// every other key fixture in this file (and from the dev sentinel, byte 9,
// in env.schema.ts) so this "valid prod default" can never collide with
// either.
const DEFAULT_AUDIT_SIGNING_KEY = Buffer.alloc(32, 8).toString('base64');

// Base on the loaded .env (setup-env.ts loads it) so all other required
// fields are already present; override only what each case exercises.
function prodEnv(overrides: Record<string, unknown>) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: DEFAULT_ENCRYPTION_KEY,
    PII_BLIND_INDEX_KEY: DEFAULT_BLIND_INDEX_KEY,
    AUDIT_SIGNING_KEY: DEFAULT_AUDIT_SIGNING_KEY,
    DB_SSL: 'true',
    DB_SSL_REJECT_UNAUTHORIZED: 'true',
    ...overrides,
  };
}

describe('validateEnv production DB TLS (GAP-07)', () => {
  it('rejects production when DB_SSL is off', () => {
    expect(() => validateEnv(prodEnv({ DB_SSL: 'false' }))).toThrow(/DB_SSL/);
  });
  it('rejects production when certificate verification is off', () => {
    expect(() => validateEnv(prodEnv({ DB_SSL_REJECT_UNAUTHORIZED: 'false' }))).toThrow(/TLS|DB_SSL/);
  });
  it('accepts production with verified TLS enabled', () => {
    expect(() => validateEnv(prodEnv({}))).not.toThrow();
  });
});

// Fill byte 5 — deliberately distinct from the DEV_ONLY_* sentinels' bytes
// (1, 2) in env.schema.ts and DEFAULT_*_KEY's bytes (3, 4) above, so this
// "real" key can never accidentally equal a dev placeholder and trip the
// dev-sentinel guard instead of exercising the 32-byte check below.
const K32 = Buffer.alloc(32, 5).toString('base64');
describe('validateEnv PII key validation (GAP-03)', () => {
  it('rejects production when PII_BLIND_INDEX_KEY does not decode to 32 bytes', () => {
    expect(() => validateEnv(prodEnv({ ENCRYPTION_KEY: K32, PII_BLIND_INDEX_KEY: Buffer.alloc(16).toString('base64') }))).toThrow(/32 bytes|PII_BLIND_INDEX_KEY/);
  });
  it('accepts production with two distinct valid 32-byte keys', () => {
    expect(() => validateEnv(prodEnv({ ENCRYPTION_KEY: K32, PII_BLIND_INDEX_KEY: Buffer.alloc(32, 6).toString('base64') }))).not.toThrow();
  });
});

// Fill byte 7 — distinct from every other key fixture in this file, so a
// "real" signing key can never accidentally collide with the dev sentinel
// in env.schema.ts (byte 9, see DEV_ONLY_AUDIT_SIGNING_KEY) or any other
// fixture above.
const AUDIT_KEY_32 = Buffer.alloc(32, 7).toString('base64');
describe('validateEnv audit checkpoint signing key (GAP-02)', () => {
  it('rejects production when AUDIT_SIGNING_KEY is left at the dev sentinel', () => {
    expect(() =>
      validateEnv(
        prodEnv({ ENCRYPTION_KEY: K32, PII_BLIND_INDEX_KEY: Buffer.alloc(32, 6).toString('base64') }),
      ),
    ).not.toThrow();
    // The dev default itself, passed explicitly, must be rejected in prod.
    expect(() =>
      validateEnv(
        prodEnv({
          ENCRYPTION_KEY: K32,
          PII_BLIND_INDEX_KEY: Buffer.alloc(32, 6).toString('base64'),
          AUDIT_SIGNING_KEY: Buffer.alloc(32, 9).toString('base64'),
        }),
      ),
    ).toThrow(/AUDIT_SIGNING_KEY/);
  });
  it('rejects production when AUDIT_SIGNING_KEY does not decode to 32 bytes', () => {
    expect(() =>
      validateEnv(
        prodEnv({
          ENCRYPTION_KEY: K32,
          PII_BLIND_INDEX_KEY: Buffer.alloc(32, 6).toString('base64'),
          AUDIT_SIGNING_KEY: Buffer.alloc(16).toString('base64'),
        }),
      ),
    ).toThrow(/32 bytes|AUDIT_SIGNING_KEY/);
  });
  it('accepts production with a valid, distinct 32-byte signing key', () => {
    expect(() =>
      validateEnv(
        prodEnv({
          ENCRYPTION_KEY: K32,
          PII_BLIND_INDEX_KEY: Buffer.alloc(32, 6).toString('base64'),
          AUDIT_SIGNING_KEY: AUDIT_KEY_32,
        }),
      ),
    ).not.toThrow();
  });
});
