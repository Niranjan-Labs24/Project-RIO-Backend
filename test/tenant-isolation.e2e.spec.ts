import { PrismaPg } from '@prisma/adapter-pg';
import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '../src/generated/prisma';
import { PrismaClient as PrismaClientCtor } from '../src/generated/prisma';
import { orgContext } from '../src/tenancy/org-context';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';
import { appClient, ownerClient } from './db.helper';

// Security CI gate for FR-010 (fail-closed, org-scoped RLS) on the DOMAIN
// tenant tables — replaces the notes-based gate the domain migration removed.
// Runs against the real Docker DB using the same adapter-backed clients as the
// app (cnap_app, NOBYPASSRLS) and CLI (cnap_owner). No mocks.
//
// `users`, `organisations` etc. all carry FORCE ROW LEVEL SECURITY, so even the
// owner only sees/writes rows for the org set via
// set_config('app.current_org_id', ...). Creating fixtures therefore sets the
// org context first (mirrors prisma/seed.ts), and cleanup deletes each test
// org's rows from inside its own org-scoped transaction so the suite re-runs.
describe('Cross-tenant isolation (RLS) — users', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let tenant: TenantPrismaService;
  const orgA = uuidv7();
  const orgB = uuidv7();
  const run = Date.now();
  const emailA = `iso-a-${run}@example.org`;
  const emailB = `iso-b-${run}@example.org`;

  async function seedOrgWithUser(orgId: string, orgName: string, email: string): Promise<void> {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`INSERT INTO organisations (id, name, updated_at) VALUES (${orgId}::uuid, ${orgName}, now())`;
      await tx.$executeRaw`INSERT INTO users (org_id, role_id, name, email, status, updated_at)
        VALUES (${orgId}::uuid, 'role_ngo_admin', ${orgName + ' Admin'}, ${email}, 'invited'::"UserStatus", now())`;
    });
  }

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    tenant = new TenantPrismaService(app as never, app as never);
    await seedOrgWithUser(orgA, 'ISO Org A', emailA);
    await seedOrgWithUser(orgB, 'ISO Org B', emailB);
  });

  afterAll(async () => {
    for (const orgId of [orgA, orgB]) {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
        await tx.$executeRaw`DELETE FROM users WHERE org_id = ${orgId}::uuid`;
        await tx.$executeRaw`DELETE FROM organisations WHERE id = ${orgId}::uuid`;
      });
    }
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('a caller in Org A sees only Org A users', async () => {
    const emails = await orgContext.run({ requestId: 'iso-a', orgId: orgA }, () =>
      tenant.runInOrgContext((tx) => tx.user.findMany({ select: { email: true } })),
    );
    const list = (emails as { email: string }[]).map((r) => r.email);
    expect(list).toContain(emailA);
    expect(list).not.toContain(emailB);
  });

  it('fails closed: with no org context a virgin connection returns zero rows (not an error)', async () => {
    // A never-scoped session: current_setting(..., true) is NULL when unset, so
    // org_id = NULL is never true and RLS returns zero rows with no error —
    // even though the DB is seeded with users in other orgs.
    const freshApp = appClient();
    try {
      const rows = await freshApp.user.findMany();
      expect(rows).toHaveLength(0);
    } finally {
      await freshApp.$disconnect();
    }
  });

  it('fails closed on a warm (reused) connection too: zero rows, not an error', async () => {
    // After a SET LOCAL org GUC commits, current_setting(..., true) reverts to
    // '' (not NULL) on that physical connection. Casting ''::uuid would raise
    // "invalid input syntax for type uuid" and make the RLS boundary ERROR
    // instead of fail closed. The NULLIF(current_setting(...), '') policy maps
    // both unset (NULL) and reverted ('') to NULL → uniform zero rows. Pinning
    // the pool to one connection reproduces the warm '' GUC state.
    const singleConn = new PrismaClientCtor({
      adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL, ssl: pgSslFromEnv(), max: 1 }),
    });
    const singleTenant = new TenantPrismaService(singleConn as never, singleConn as never);
    try {
      await orgContext.run({ requestId: 'warm', orgId: orgA }, () =>
        singleTenant.runInOrgContext((tx) => tx.user.findMany()),
      );
      const rows = await singleConn.user.findMany();
      expect(rows).toHaveLength(0);
    } finally {
      await singleConn.$disconnect();
    }
  });
});
