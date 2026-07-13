import type { PoolConfig } from 'pg';

// Encryption in transit to Postgres (RIO-NFR-001). When enabled the pg driver
// negotiates TLS. Self-signed certs are accepted (rejectUnauthorized: false) —
// the dev db image ships a self-signed cert; a real deployment supplies a
// CA-signed one and can tighten this.
export function pgSslOption(enabled: boolean): PoolConfig['ssl'] {
  return enabled ? { rejectUnauthorized: false } : undefined;
}

// For scripts/tests without a ConfigService (seed, db.helper): read DB_SSL env.
export function pgSslFromEnv(): PoolConfig['ssl'] {
  return pgSslOption(process.env.DB_SSL === 'true');
}
