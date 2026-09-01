import { v7 as uuidv7 } from 'uuid';
import type { PrismaClient } from '../src/generated/prisma';
import { orgContext } from '../src/tenancy/org-context';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { EvidenceService } from '../src/modules/evidence/evidence.service';
import { MAX_EVIDENCE_FILES_PER_STUDY } from '../src/modules/evidence/evidence.storage.service';
import type { UploadedFilePayload } from '../src/modules/evidence/evidence.types';
import { appClient, ownerClient } from './db.helper';

// GAP-12 true-race proof. Before the fix, EvidenceService.upload counted
// existing Evidence rows and inserted new ones in TWO SEPARATE
// runInOrgContext transactions (Read Committed) with no DB-level
// serialization — two concurrent uploads for the same Need could both read
// count < MAX_EVIDENCE_FILES_PER_STUDY before either committed its inserts,
// letting the per-need cap be exceeded. The fix takes a per-need Postgres
// advisory lock (pg_advisory_xact_lock(hashtext('evidence:' + needId)))
// inside the SAME transaction as the (re-)count and the inserts, so
// concurrent uploads for one need are fully serialized: the second
// transaction blocks until the first commits (or rolls back) and its count
// then reflects the first upload's rows.
//
// Modeled on tenant-isolation.e2e.spec.ts: real ownerClient/appClient against
// the Docker Postgres instance, org context set via
// set_config('app.current_org_id', ...), a real TenantPrismaService(app, app)
// (the second/"supervisor" arg is unused by upload's runInOrgContext path).
// storage and audit are stubbed — this test is about the DB race, not disk
// I/O or the audit log — matching the plan's "stub storage/audit" guidance.
describe('EvidenceService.upload — GAP-12 concurrent capacity race (e2e)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let tenant: TenantPrismaService;
  const orgId = uuidv7();
  let studyId: string;
  let needId: string;
  const actorId = uuidv7();
  const run = Date.now();

  function file(name: string, content: string): UploadedFilePayload {
    return { originalName: name, mimeType: 'text/plain', sizeBytes: content.length, buffer: Buffer.from(content) };
  }

  // Minimal stand-ins matching the slice of EvidenceStorageService /
  // AuditService that EvidenceService.upload actually calls — no disk I/O,
  // no audit-log DB writes, so the test isolates the capacity race itself.
  function fakeStorage() {
    let seq = 0;
    return {
      assertAllowedExtension: () => {},
      assertAllowedSize: () => {},
      assertFileSignature: () => {},
      hashBuffer: (buffer: Buffer) => {
        seq += 1;
        // Unique per call so no two files in this test are ever flagged as
        // duplicates of one another (irrelevant to the race being tested).
        return `${buffer.toString('utf8')}-${seq}-${Math.random()}`;
      },
      save: async (name: string) => `key-${name}-${Math.random()}`,
      remove: async () => {},
    };
  }
  const fakeAudit = { record: async () => {} };

  beforeAll(async () => {
    owner = ownerClient();
    app = appClient();
    tenant = new TenantPrismaService(app as never, app as never);

    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`INSERT INTO organisations (id, name, updated_at) VALUES (${orgId}::uuid, ${'Race Test Org ' + run}, now())`;
    });

    studyId = uuidv7();
    needId = uuidv7();
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      await tx.$executeRaw`
        INSERT INTO studies (id, org_id, title, cycle_number, status, created_by, updated_at)
        VALUES (${studyId}::uuid, ${orgId}::uuid, ${'Race Test Study'}, 1, 'active', ${actorId}::uuid, now())
      `;
      await tx.$executeRaw`
        INSERT INTO needs (id, study_id, org_id, title, statement, source, status, created_by, updated_at)
        VALUES (${needId}::uuid, ${studyId}::uuid, ${orgId}::uuid, ${'Race Test Need'}, ${'Statement for race test'}, 'manual_entry'::"NeedSource", 'draft'::"NeedStatus", ${actorId}::uuid, now())
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
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('serializes concurrent uploads for the same need so the total never exceeds the per-need cap', async () => {
    const svc = new EvidenceService(tenant, fakeAudit as never, fakeStorage() as never);
    const ctx = { requestId: 'race-test', orgId, actorId };

    // Two concurrent batches that TOGETHER exceed MAX_EVIDENCE_FILES_PER_STUDY
    // (10): 6 + 6 = 12 > 10. Before the fix, both batches' count() calls could
    // read 0 existing rows (separate transactions, no lock) and both would
    // proceed to insert all 6, landing on 12 total. After the fix, the
    // advisory lock forces the second transaction to wait for the first to
    // commit; its re-count then sees the first batch's rows and the batch
    // that would push the total over 10 is rejected wholesale (this need
    // starts empty, so whichever batch runs first fully succeeds, and the
    // second's incremental math takes it over the cap and is rejected
    // outright, per the existing "reject the whole batch over the cap"
    // behavior) — either way, total rows created is bounded by the cap.
    const batchA = Array.from({ length: 6 }, (_, i) => file(`a${i}.pdf`, `content-a-${i}`));
    const batchB = Array.from({ length: 6 }, (_, i) => file(`b${i}.pdf`, `content-b-${i}`));

    const results = await Promise.allSettled([
      orgContext.run(ctx, () => svc.upload(needId, batchA)),
      orgContext.run(ctx, () => svc.upload(needId, batchB)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // At least one of the two concurrent batches must be rejected — if both
    // succeeded, the pre-fix race is back (12 rows, over the 10 cap).
    expect(rejected.length).toBeGreaterThanOrEqual(1);

    // The DB is the source of truth: count actual Evidence rows for this
    // need and assert the total never exceeds the per-need cap. This is the
    // assertion that would FAIL without the advisory lock serializing the
    // count+insert — both transactions would read count=0 under Read
    // Committed and both would insert their full batch (12 total).
    const totalRows = await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return tx.evidence.count({ where: { needId } });
    });
    expect(totalRows).toBeLessThanOrEqual(MAX_EVIDENCE_FILES_PER_STUDY);

    // Sanity: exactly the fulfilled batch(es)' rows exist, nothing partial
    // from the rejected batch (its files were rolled back, not left orphaned
    // as "committed" — remove() is called in the catch path, but even absent
    // that, the DB rows themselves are the authority here).
    const fulfilledCount = fulfilled.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? (r.value as unknown[]).length : 0),
      0,
    );
    expect(totalRows).toBe(fulfilledCount);
  });
});
