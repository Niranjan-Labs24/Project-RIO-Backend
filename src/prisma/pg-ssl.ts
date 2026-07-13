import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export interface PgSslSettings {
  enabled: boolean;
  // Verify the server certificate against a trusted CA. Defaults to false so
  // the self-signed dev cert works out of the box; set true in production to
  // get authentication (not just encryption) and defeat MITM.
  rejectUnauthorized?: boolean;
  // Optional path to a CA/chain PEM to trust (needed with rejectUnauthorized
  // when the server cert is not signed by a system-trusted CA).
  caPath?: string;
}

// Encryption in transit to Postgres (RIO-NFR-001). When enabled the pg driver
// negotiates TLS. By default certificates are NOT verified (dev self-signed);
// production should set DB_SSL_REJECT_UNAUTHORIZED=true (+ DB_SSL_CA if the
// cert is not signed by a system-trusted CA) so the connection is authenticated.
export function pgSslOption(settings: boolean | PgSslSettings): PoolConfig['ssl'] {
  const s: PgSslSettings = typeof settings === 'boolean' ? { enabled: settings } : settings;
  if (!s.enabled) return undefined;
  const ca = s.caPath ? readFileSync(s.caPath, 'utf8') : undefined;
  return { rejectUnauthorized: s.rejectUnauthorized ?? false, ...(ca ? { ca } : {}) };
}

// For scripts/tests without a ConfigService (seed, db.helper): read DB_SSL env.
export function pgSslFromEnv(): PoolConfig['ssl'] {
  return pgSslOption({
    enabled: process.env.DB_SSL === 'true',
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
    caPath: process.env.DB_SSL_CA || undefined,
  });
}
