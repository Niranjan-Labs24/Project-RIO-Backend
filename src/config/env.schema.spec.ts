import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema';

// Base on the loaded .env (setup-env.ts loads it) so all other required
// fields are already present; override only what each case exercises.
function prodEnv(overrides: Record<string, unknown>) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    REDIS_URL: 'redis://localhost:6379',
    ENCRYPTION_KEY: 'x'.repeat(32),
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
