import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

// Prisma 7 removed `datasourceUrl` from the client constructor; an explicit
// driver adapter is required. This mirrors the pattern in
// src/prisma/prisma.service.ts so tests exercise the same connection path
// as the running app (and the CLI/migrate tooling), including DB_SSL.

/** Owner client (cnap_owner) for setup that must not be RLS-scoped. */
export function ownerClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }) });
}

/** App client (cnap_app, NOBYPASSRLS) — mirrors the running app's connection. */
export function appClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL, ssl: pgSslFromEnv() }),
  });
}

/**
 * Supervisor client (cnap_supervisor, NOBYPASSRLS, cross-org SELECT policies) —
 * the read path TenantPrismaService.runAsSupervisor uses. Needed so tests that
 * exercise runAsSupervisor (e.g. the GAP-04 score_response task's response/
 * survey refetch) see rows across orgs, exactly as the running app does.
 */
export function supervisorClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
  });
}
