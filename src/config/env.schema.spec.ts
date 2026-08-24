import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

// Valid 32-byte base64 keys (GAP-03: both ENCRYPTION_KEY and
// PII_BLIND_INDEX_KEY must decode to exactly 32 bytes) — distinct byte
// patterns so a default-vs-default comparison in validateEnv can't
// accidentally pass. Used as prodEnv()'s defaults so every pre-existing
// case that doesn't care about key validation still passes it.
const DEFAULT_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
const DEFAULT_BLIND_INDEX_KEY = Buffer.alloc(32, 4).toString('base64');

// Base on the loaded .env (setup-env.ts loads it) so all other required
// fields are already present; override only what each case exercises.
function prodEnv(overrides: Record<string, unknown>) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: DEFAULT_ENCRYPTION_KEY,
    PII_BLIND_INDEX_KEY: DEFAULT_BLIND_INDEX_KEY,
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
