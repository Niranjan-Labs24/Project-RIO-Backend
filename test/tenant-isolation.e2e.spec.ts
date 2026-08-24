import { PrismaPg } from '@prisma/adapter-pg';
import { v7 as uuidv7 } from 'uuid';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaClient } from '../src/generated/prisma';
import { PrismaClient as PrismaClientCtor } from '../src/generated/prisma';
import { orgContext } from '../src/tenancy/org-context';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';
import { appClient, ownerClient } from './db.helper';
import { AuditCheckpointService } from '../src/modules/audit/audit-checkpoint.service';
import type { ConfigService } from '../src/config/config.service';

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

// GAP-02 — tamper-evident audit via signed checkpoints, against the real
// Docker DB (no mocks): seed audit_logs rows, run the checkpoint job,
// verify it reports ok, then tamper a covered row directly (as owner —
// the same privileged-actor threat model the checkpoint chain exists to
// detect) and confirm verify() now reports a mismatch.
describe('Audit checkpoint integrity (GAP-02)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let tenant: TenantPrismaService;
  let service: AuditCheckpointService;
  const orgC = uuidv7();
  const KEY = Buffer.alloc(32, 5).toString('base64');
  // Every audit_logs id this suite seeds — tracked so afterAll can safely
  // unwind exactly the checkpoints this run appended (see afterAll).
  const seededIds: string[] = [];

  function fakeConfig(): ConfigService {
    return { auditCheckpointCron: '0 * * * *', auditSigningKey: KEY } as unknown as ConfigService;
  }
  function fakeSchedulerRegistry(): SchedulerRegistry {
    return { addCronJob: () => undefined } as unknown as SchedulerRegistry;
  }

  async function seedAuditRow(action: string, label: string): Promise<string> {
    const id = uuidv7();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgC}, true)`;
      await tx.$executeRaw`
        INSERT INTO audit_logs (id, organisation_id, action, entity_type, entity_label, created_at)
        VALUES (${id}::uuid, ${orgC}::uuid, ${action}, 'test_entity', ${label}, now())
      `;
    });
    seededIds.push(id);
    return id;
  }

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    // Checkpoint reads are genuinely cross-org (runAsSupervisor) — this
    // needs the real cnap_supervisor-role connection, not the app client
    // reused in its place (that role has no org GUC set, and audit_logs'
    // RLS policy then matches organisation_id = NULL, i.e. zero rows: every
    // checkpoint read would silently see nothing).
    const supervisor = new PrismaClientCtor({
      adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
    });
    tenant = new TenantPrismaService(app as never, supervisor as never);
    service = new AuditCheckpointService(fakeConfig(), tenant, fakeSchedulerRegistry());
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgC}, true)`;
      await tx.$executeRaw`INSERT INTO organisations (id, name, updated_at) VALUES (${orgC}::uuid, 'ISO Org C (checkpoint)', now())`;
    });
  });

  afterAll(async () => {
    // audit_checkpoints is a single global, shared, append-only chain (no
    // org scoping — see the migration's no-RLS comment): deleting a
    // checkpoint from the *middle* of the chain (e.g. one covering other
    // suites' pre-existing rows) would corrupt it for everyone. But leaving
    // OUR OWN trailing checkpoints in place while deleting the audit_logs
    // rows they cover is worse — a checkpoint whose covered row no longer
    // exists is indistinguishable from tampering, and would permanently
    // fail verify() for every later run against this shared dev DB. Since
    // this test always runs its checkpoint() calls last, its checkpoints
    // are the chain's current tail — safe to unwind, newest-first, for
    // exactly as long as each one's covered_to_id is one of ours.
    const seeded = new Set(seededIds);
    const chain = await owner.auditCheckpoint.findMany({ orderBy: { createdAt: 'desc' } });
    for (const cp of chain) {
      if (!seeded.has(cp.coveredToId)) break;
      await owner.auditCheckpoint.delete({ where: { id: cp.id } });
    }

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgC}, true)`;
      await tx.$executeRaw`DELETE FROM audit_logs WHERE organisation_id = ${orgC}::uuid`;
    });
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgC}, true)`;
      await tx.$executeRaw`DELETE FROM organisations WHERE id = ${orgC}::uuid`;
    });
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('checkpoints seeded rows and verify() reports ok', async () => {
    await seedAuditRow('create', 'Row One');
    await seedAuditRow('edit', 'Row Two');

    await service.checkpoint();
    const result = await service.verify();

    expect(result.ok).toBe(true);
  });

  it('detects tampering: an owner-edited covered row makes verify() fail', async () => {
    const tamperedId = await seedAuditRow('create', 'Original Label');
    await service.checkpoint();
    expect((await service.verify()).ok).toBe(true);

    // Privileged-actor tamper: bypass the app entirely (cnap_app has no
    // UPDATE grant on audit_logs) via the owner connection.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgC}, true)`;
      await tx.$executeRaw`UPDATE audit_logs SET entity_label = 'HACKED' WHERE id = ${tamperedId}::uuid`;
    });

    const result = await service.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenCheckpointId).toBeDefined();
  });
});
