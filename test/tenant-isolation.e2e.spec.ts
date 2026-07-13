import { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaClient } from '../src/generated/prisma';
import { PrismaClient as PrismaClientCtor } from '../src/generated/prisma';
import { orgContext } from '../src/tenancy/org-context';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { NotesRepository } from '../src/modules/notes/notes.repository';
import { appClient, ownerClient } from './db.helper';

// This is the security CI gate for AD-1 (fail-closed, org-scoped RLS on
// notes). It runs against the real Docker DB using the same adapter-backed
// client construction as the running app (see src/prisma/prisma.service.ts)
// and the Prisma CLI (see prisma.config.ts) — no mocks.
//
// Cleanup note: `notes` carries FORCE ROW LEVEL SECURITY, so even the owner
// role only sees/affects rows for the org currently set via
// set_config('app.current_org_id', ...). A bare `DELETE FROM notes` with no
// org context in scope matches zero rows. afterAll therefore deletes each
// test org's notes from inside an org-scoped transaction before removing the
// (non-RLS) organisations rows, so the suite is safe to re-run repeatedly.
describe('Cross-tenant isolation (RLS)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let tenant: TenantPrismaService;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    tenant = new TenantPrismaService(app as never);

    const a = await owner.organisation.create({
      data: { name: 'ISO Org A', purpose: 'Test', registrationNumber: `ISO-A-${Date.now()}` },
    });
    const b = await owner.organisation.create({
      data: { name: 'ISO Org B', purpose: 'Test', registrationNumber: `ISO-B-${Date.now()}` },
    });
    orgA = a.id;
    orgB = b.id;

    for (const [org, body] of [
      [orgA, 'A-secret'],
      [orgB, 'B-secret'],
    ] as const) {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${org}, true)`;
        await tx.$executeRaw`INSERT INTO notes (org_id, body) VALUES (${org}::uuid, ${body})`;
      });
    }
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${org}, true)`;
        await tx.$executeRaw`DELETE FROM notes WHERE org_id = ${org}::uuid`;
      });
    }
    await owner.organisation.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('a caller in Org A sees only Org A notes', async () => {
    const rows = await orgContext.run({ requestId: 'iso-a', orgId: orgA }, () =>
      tenant.runInOrgContext((tx) => tx.note.findMany()),
    );
    const bodies = (rows as { body: string }[]).map((r) => r.body);
    expect(bodies).toContain('A-secret');
    expect(bodies).not.toContain('B-secret');
  });

  it('fails closed: with no org context the query returns zero rows', async () => {
    // Use a dedicated, never-before-used client/connection for this check.
    // Postgres custom GUCs are session-scoped placeholders: on a genuinely
    // virgin session current_setting(..., true) returns NULL when unset, so
    // org_id = NULL is never true and RLS returns zero rows with no error.
    const freshApp = appClient();
    try {
      const rows = await freshApp.note.findMany(); // no set_config → RLS denies, not an error
      expect(rows).toHaveLength(0);
    } finally {
      await freshApp.$disconnect();
    }
  });

  it('fails closed on a warm (reused) connection too: zero rows, not an error', async () => {
    // Postgres custom GUCs are session-scoped placeholders: once a physical
    // connection has run `set_config('app.current_org_id', ..., true)`
    // (SET LOCAL semantics) at least once, current_setting(..., true)
    // reverts to '' (not NULL) on that same connection after commit. Naively
    // casting '' to uuid raises "invalid input syntax for type uuid", which
    // would make the RLS boundary error instead of returning zero rows.
    // The notes_org_isolation policy uses NULLIF(current_setting(...), '')
    // so both the unset (NULL) and reverted-to-empty ('') states collapse to
    // NULL, keeping fail-closed behaviour uniform (zero rows, never an
    // error). This test pins a single physical connection (pg Pool max: 1)
    // so the "warm" set_config → commit → unscoped query sequence reliably
    // reuses the same backend connection and reproduces the '' GUC state.
    const singleConnClient = new PrismaClientCtor({
      adapter: new PrismaPg({ connectionString: process.env.APP_DATABASE_URL, max: 1 }),
    });
    const singleConnTenant = new TenantPrismaService(singleConnClient as never);
    try {
      // 1. Warm the connection: run an org-scoped query so set_config(...)
      // runs (and reverts to '' on commit) on this pinned connection.
      await orgContext.run({ requestId: 'warm-conn', orgId: orgA }, () =>
        singleConnTenant.runInOrgContext((tx) => tx.note.findMany()),
      );

      // 2. Immediately reuse the same physical connection for an unscoped
      // query. Pre-hardening this would throw "invalid input syntax for
      // type uuid"; post-hardening it must return zero rows.
      const rows = await singleConnClient.note.findMany();
      expect(rows).toHaveLength(0);
    } finally {
      await singleConnClient.$disconnect();
    }
  });

  it('NotesRepository.create writes via the real raw-SQL insert path and is tenant-scoped', async () => {
    const repo = new NotesRepository(new TenantPrismaService(app as never));

    const created = await orgContext.run({ requestId: 'repo-create', orgId: orgA }, () =>
      repo.create({ body: 'via-repo' }),
    );

    expect(created.body).toBe('via-repo');
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);

    const visibleInA = await orgContext.run({ requestId: 'repo-check-a', orgId: orgA }, () =>
      tenant.runInOrgContext((tx) => tx.note.findMany({ where: { id: created.id } })),
    );
    expect(visibleInA).toHaveLength(1);

    const visibleInB = await orgContext.run({ requestId: 'repo-check-b', orgId: orgB }, () =>
      tenant.runInOrgContext((tx) => tx.note.findMany({ where: { id: created.id } })),
    );
    expect(visibleInB).toHaveLength(0);
  });
});
