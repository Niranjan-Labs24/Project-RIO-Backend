import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// Prisma 7 removed `datasourceUrl` from the client constructor; an explicit
// driver adapter is required. This mirrors the pattern in
// src/prisma/prisma.service.ts so tests exercise the same connection path
// as the running app (and the CLI/migrate tooling).

/** Owner client (cnap_owner) for setup that must not be RLS-scoped. */
export function ownerClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
}

/** App client (cnap_app, NOBYPASSRLS) — mirrors the running app's connection. */
export function appClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL }),
  });
}
