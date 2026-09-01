import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { PrismaClient } from '../src/generated/prisma';
import { orgContext } from '../src/tenancy/org-context';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { EvidenceService } from '../src/modules/evidence/evidence.service';
import { EvidenceStorageService } from '../src/modules/evidence/evidence.storage.service';
import { EvidenceFileCleanupService } from '../src/modules/evidence/evidence-file-cleanup.service';
import type { UploadedFilePayload } from '../src/modules/evidence/evidence.types';
import { appClient, ownerClient } from './db.helper';

// GAP-13 DB-gated integration proof. Runs against the real Docker Postgres
// instance on 127.0.0.1:55432 (same connection helpers as
// tenant-isolation.e2e.spec.ts / evidence-upload-race.e2e.spec.ts) with a
// real filesystem storage directory (mkdtempSync) — no mocking of Postgres,
// no mocking of the storage layer's fs calls. The "unlink failure" is
// genuine: the file really is missing from disk when EvidenceService.remove
// calls storage.remove(), so the real unlink() really throws ENOENT.
//
// Flow:
//   1. Real upload() writes a real file + a real Evidence row.
//   2. The file is deleted out from under the app (simulating disk drift —
//      e.g. a prior partial failure, manual ops intervention, etc.) so the
//      upcoming remove() call's unlink genuinely fails.
//   3. remove() deletes the Evidence row (real DB) and, because the physical
//      delete genuinely failed, inserts a real PendingFileDeletion row.
//   4. A query against the real DB proves that row exists.
//   5. A file is placed back at that exact storageKey (making the retry
//      "removable" again), and EvidenceFileCleanupService.sweep() runs for
//      real against the real DB and real filesystem.
//   6. A query against the real DB proves the row is gone.
describe('EvidenceFileCleanupService — GAP-13 durable retry (e2e)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let tenant: TenantPrismaService;
  let storageDir: string;
  let storage: EvidenceStorageService;
  const orgId = uuidv7();
  const actorId = uuidv7();
  const run = Date.now();
  let studyId: string;
  let needId: string;

  const fakeAudit = { record: async () => {} };

  function file(name: string, content: string): UploadedFilePayload {
    // EvidenceStorageService.assertFileSignature checks real magic bytes for
    // .pdf (must start with "%PDF-") — this is a real upload() call, so the
    // content has to genuinely pass that check, not just look like a PDF by
    // extension.
    const buffer = Buffer.from(`%PDF-1.4\n${content}`);
    return { originalName: name, mimeType: 'application/pdf', sizeBytes: buffer.length, buffer };
  }

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    tenant = new TenantPrismaService(app as never, app as never);
    storageDir = mkdtempSync(join(tmpdir(), 'evidence-cleanup-e2e-'));
    storage = new EvidenceStorageService({ evidenceStoragePath: storageDir } as never);

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`INSERT INTO organisations (id, name, updated_at) VALUES (${orgId}::uuid, ${'Cleanup E2E Org ' + run}, now())`;
    });

    studyId = uuidv7();
    needId = uuidv7();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`
        INSERT INTO studies (id, org_id, title, cycle_number, status, created_by, updated_at)
        VALUES (${studyId}::uuid, ${orgId}::uuid, ${'Cleanup E2E Study'}, 1, 'active', ${actorId}::uuid, now())
      `;
      await tx.$executeRaw`
        INSERT INTO needs (id, study_id, org_id, title, statement, source, status, created_by, updated_at)
        VALUES (${needId}::uuid, ${studyId}::uuid, ${orgId}::uuid, ${'Cleanup E2E Need'}, ${'Statement for cleanup e2e test'}, 'manual_entry'::"NeedSource", 'draft'::"NeedStatus", ${actorId}::uuid, now())
      `;
    });
  });

  afterAll(async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`DELETE FROM evidence WHERE need_id = ${needId}::uuid`;
      await tx.$executeRaw`DELETE FROM needs WHERE id = ${needId}::uuid`;
      await tx.$executeRaw`DELETE FROM studies WHERE id = ${studyId}::uuid`;
      await tx.$executeRaw`DELETE FROM organisations WHERE id = ${orgId}::uuid`;
    });
    // pending_file_deletions is a global table with no org_id — clean up
    // directly rather than through the org-scoped transaction above.
    await owner.$executeRaw`DELETE FROM pending_file_deletions WHERE storage_key LIKE ${'cleanup-e2e-%'}`;
    await owner.$disconnect();
    await app.$disconnect();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('records a real PendingFileDeletion row when the physical delete genuinely fails, then clears it once the sweep can genuinely retry it', async () => {
    const ctx = { requestId: 'cleanup-e2e', orgId, actorId };
    const evidenceService = new EvidenceService(tenant, fakeAudit as never, storage);

    // 1. Real upload: writes a real file under storageDir and a real
    // Evidence row in Postgres.
    const [uploaded] = await orgContext.run(ctx, () =>
      evidenceService.upload(needId, [file('cleanup-e2e-proof.pdf', 'genuine evidence content')]),
    );
    expect(uploaded).toBeDefined();

    const storageKey = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      const row = await tx.evidence.findUnique({ where: { id: uploaded!.id }, select: { storageKey: true } });
      return row!.storageKey;
    });
    const filePath = join(storageDir, storageKey);
    expect(existsSync(filePath)).toBe(true);

    // 2. Simulate disk drift: the file is genuinely gone before remove() is
    // ever called, so the real unlink() inside storage.remove() will
    // genuinely fail with ENOENT — nothing here is mocked or stubbed.
    rmSync(filePath, { force: true });
    expect(existsSync(filePath)).toBe(false);

    // 3. remove() deletes the DB row and, because the physical delete
    // genuinely failed, inserts a real PendingFileDeletion row via
    // runAsSupervisorWrite.
    await orgContext.run(ctx, () => evidenceService.remove(uploaded!.id));

    // 4. Prove against the REAL database that the row exists — genuine
    // query output, not a mock assertion.
    const pendingAfterFailure = await owner.$queryRaw<{ id: string; storage_key: string; attempts: number }[]>`
      SELECT id, storage_key, attempts FROM pending_file_deletions WHERE storage_key = ${storageKey}
    `;
    console.log('[GAP-13 e2e] pending_file_deletions after genuine unlink failure:', JSON.stringify(pendingAfterFailure));
    expect(pendingAfterFailure).toHaveLength(1);
    expect(pendingAfterFailure[0]?.storage_key).toBe(storageKey);
    expect(pendingAfterFailure[0]?.attempts).toBe(0);

    // The Evidence row itself must be genuinely gone (the DB delete inside
    // remove()'s transaction is not affected by the storage failure).
    const evidenceRowCount = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return tx.evidence.count({ where: { id: uploaded!.id } });
    });
    expect(evidenceRowCount).toBe(0);

    // 5. Make the retry genuinely "removable": put a real file back at the
    // exact same storageKey path the pending row references, so the sweep's
    // retry unlink() will genuinely succeed this time.
    writeFileSync(filePath, 'file restored so the retry can genuinely succeed');
    expect(existsSync(filePath)).toBe(true);

    // 6. Run the real sweep — real TenantPrismaService against real
    // Postgres, real EvidenceStorageService against the real filesystem.
    const fakeScheduler = { addCronJob: () => {} } as unknown as SchedulerRegistry;
    const fakeConfig = { evidenceCleanupCron: '0 4 * * *' } as never;
    const cleanupService = new EvidenceFileCleanupService(fakeConfig, tenant, fakeScheduler, storage);

    await cleanupService.sweep();

    // 7. Prove against the REAL database that the row is now cleared.
    const pendingAfterSweep = await owner.$queryRaw<{ id: string }[]>`
      SELECT id FROM pending_file_deletions WHERE storage_key = ${storageKey}
    `;
    console.log('[GAP-13 e2e] pending_file_deletions after successful sweep retry:', JSON.stringify(pendingAfterSweep));
    expect(pendingAfterSweep).toHaveLength(0);

    // And the retried unlink genuinely ran against the real filesystem.
    expect(existsSync(filePath)).toBe(false);
  });
});
