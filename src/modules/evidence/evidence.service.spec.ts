import { ConflictException, NotFoundException } from '@nestjs/common';
import { orgContext } from '../../tenancy/org-context';
import { EvidenceService } from './evidence.service';
import { MAX_EVIDENCE_FILES_PER_STUDY } from './evidence.storage.service';
import type { EvidenceRow, UploadedFilePayload } from './evidence.types';

function file(name: string, content: string): UploadedFilePayload {
  return { originalName: name, mimeType: 'text/plain', sizeBytes: content.length, buffer: Buffer.from(content) };
}

// hashBuffer is stubbed as an identity function on the buffer's text content
// instead of real sha256 — the service's grouping/duplicate-flagging logic
// under test doesn't depend on the hash algorithm, only on "same content in
// -> same hash out". The real sha256 implementation is covered separately in
// evidence.storage.service.spec.ts.
function fakeStorage(opts: { onSave?: (name: string, buffer: Buffer) => void; onRemove?: (key: string) => void } = {}) {
  return {
    assertAllowedExtension: () => {},
    assertAllowedSize: () => {},
    assertFileSignature: () => {},
    hashBuffer: (buffer: Buffer) => buffer.toString('utf8'),
    save: async (name: string, buffer: Buffer) => {
      opts.onSave?.(name, buffer);
      return `key-${name}`;
    },
    remove: async (key: string) => {
      opts.onRemove?.(key);
    },
  };
}

function fakeTenant(opts: {
  need?: { studyId: string; status?: string } | null;
  existingEvidenceCount?: number;
  existingHashes?: (string | null)[];
  evidenceRow?: EvidenceRow | null;
  onEvidenceCreate?: (data: Record<string, unknown>) => void;
  onEvidenceDelete?: (where: unknown) => void;
  users?: { id: string; name: string }[];
  // GAP-12: records every call made against a tx, in order, tagged with
  // which runInOrgContext invocation it happened in — lets the race-fix
  // test assert the count+create happen inside ONE transaction and that
  // the advisory lock is taken first.
  onCall?: (call: { txInvocation: number; op: string; args?: unknown }) => void;
}) {
  let idCounter = 0;
  let txInvocation = 0;
  function makeTx(invocation: number) {
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        opts.onCall?.({ txInvocation: invocation, op: 'executeRaw', args: { strings: strings.join('?'), values } });
        return 0;
      },
      need: {
        findUnique: async () => {
          opts.onCall?.({ txInvocation: invocation, op: 'need.findUnique' });
          return opts.need ?? null;
        },
      },
      evidence: {
        count: async () => {
          opts.onCall?.({ txInvocation: invocation, op: 'evidence.count' });
          return opts.existingEvidenceCount ?? 0;
        },
        findMany: async (args?: { select?: { fileHash?: boolean } }) => {
          opts.onCall?.({ txInvocation: invocation, op: 'evidence.findMany', args });
          if (args?.select?.fileHash) {
            return (opts.existingHashes ?? []).map((h) => ({ fileHash: h }));
          }
          return [];
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          idCounter += 1;
          opts.onCall?.({ txInvocation: invocation, op: 'evidence.create', args: data });
          opts.onEvidenceCreate?.(data);
          return { id: `ev-${idCounter}`, uploadedAt: new Date('2026-01-01T00:00:00Z'), ...data };
        },
        findUnique: async () => opts.evidenceRow ?? null,
        delete: async ({ where }: { where: unknown }) => {
          opts.onEvidenceDelete?.(where);
        },
      },
      user: {
        findMany: async () => opts.users ?? [],
      },
    };
  }
  return {
    runInOrgContext: async (fn: (tx: unknown) => unknown) => {
      txInvocation += 1;
      return fn(makeTx(txInvocation));
    },
  };
}

function makeService(
  tenant: ReturnType<typeof fakeTenant>,
  storage: ReturnType<typeof fakeStorage> = fakeStorage(),
  audit: unknown = { record: async () => {} },
) {
  return new EvidenceService(tenant as never, audit as never, storage as never);
}

const ctx = { requestId: 'r', orgId: 'o1', actorId: 'me' };

describe('EvidenceService', () => {
  describe('upload', () => {
    it('404s when the need does not exist', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(
        orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')])),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s when the upload would exceed the per-need file limit', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' }, existingEvidenceCount: MAX_EVIDENCE_FILES_PER_STUDY }));
      await expect(
        orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')])),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('computes and persists fileHash from the in-memory buffer, stamping both needId and the parent studyId', async () => {
      let created: Record<string, unknown> | undefined;
      const svc = makeService(
        fakeTenant({ need: { studyId: 'study-1', status: 'draft' }, onEvidenceCreate: (d) => { created = d; } }),
      );
      await orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')]));
      expect(created?.fileHash).toBe('content-a');
      expect(created?.needId).toBe('need-1');
      expect(created?.studyId).toBe('study-1');
    });

    it('flags isDuplicate=false for the first upload of a new hash', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' } }));
      const [evidence] = await orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')]));
      expect(evidence?.isDuplicate).toBe(false);
    });

    it('flags isDuplicate=true when the hash already exists for this need', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' }, existingHashes: ['content-a'] }));
      const [evidence] = await orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')]));
      expect(evidence?.isDuplicate).toBe(true);
    });

    it('ignores null fileHash rows (pre-existing evidence from before the column existed) when checking for duplicates', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' }, existingHashes: [null] }));
      const [evidence] = await orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')]));
      expect(evidence?.isDuplicate).toBe(false);
    });

    it('flags the second copy of the same file within one batch, but not the first', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' } }));
      const [first, second] = await orgContext.run(ctx, () =>
        svc.upload('need-1', [file('a.pdf', 'same-content'), file('b.pdf', 'same-content')]),
      );
      expect(first?.isDuplicate).toBe(false);
      expect(second?.isDuplicate).toBe(true);
    });

    it('does not flag two different files as duplicates of each other', async () => {
      const svc = makeService(fakeTenant({ need: { studyId: 'study-1', status: 'draft' } }));
      const [first, second] = await orgContext.run(ctx, () =>
        svc.upload('need-1', [file('a.pdf', 'content-a'), file('b.pdf', 'content-b')]),
      );
      expect(first?.isDuplicate).toBe(false);
      expect(second?.isDuplicate).toBe(false);
    });

    // GAP-12: the capacity check (count) and the create loop used to run in
    // two SEPARATE runInOrgContext transactions, leaving a Read-Committed
    // window where two concurrent uploads for the same need could both pass
    // the count check before either inserted. The fix serializes per-need
    // uploads with a Postgres advisory lock and performs the (re-)count and
    // the inserts inside ONE transaction.
    it('takes a per-need advisory lock and performs the capacity count and the inserts inside a single runInOrgContext transaction', async () => {
      const calls: { txInvocation: number; op: string; args?: unknown }[] = [];
      const svc = makeService(
        fakeTenant({
          need: { studyId: 'study-1', status: 'draft' },
          existingEvidenceCount: 0,
          onCall: (c) => calls.push(c),
        }),
      );
      await orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')]));

      // find calls after the need.findUnique lookup(s) — the count and create
      // must share one transaction invocation.
      const countCall = calls.find((c) => c.op === 'evidence.count');
      const createCall = calls.find((c) => c.op === 'evidence.create');
      const lockCall = calls.find((c) => c.op === 'executeRaw');
      expect(countCall).toBeDefined();
      expect(createCall).toBeDefined();
      expect(lockCall).toBeDefined();

      // Same transaction invocation for lock + count + create.
      expect(lockCall?.txInvocation).toBe(countCall?.txInvocation);
      expect(countCall?.txInvocation).toBe(createCall?.txInvocation);

      // Lock must be taken before the count, which must happen before create,
      // all within that shared invocation.
      const sharedInvocation = countCall?.txInvocation;
      const orderedOps = calls
        .filter((c) => c.txInvocation === sharedInvocation)
        .map((c) => c.op);
      const lockIdx = orderedOps.indexOf('executeRaw');
      const countIdx = orderedOps.indexOf('evidence.count');
      const createIdx = orderedOps.indexOf('evidence.create');
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(lockIdx).toBeLessThan(countIdx);
      expect(countIdx).toBeLessThan(createIdx);

      // The advisory lock must be keyed per-need (hashtext of a string that
      // includes the needId), not global.
      const lockArgs = lockCall?.args as { strings: string; values: unknown[] } | undefined;
      expect(lockArgs?.values).toContain('evidence:need-1');
    });

    it('409s when the upload would exceed the per-need file limit, using the count taken inside the same locked transaction', async () => {
      const calls: { txInvocation: number; op: string }[] = [];
      const svc = makeService(
        fakeTenant({
          need: { studyId: 'study-1', status: 'draft' },
          existingEvidenceCount: MAX_EVIDENCE_FILES_PER_STUDY,
          onCall: (c) => calls.push(c),
        }),
      );
      await expect(
        orgContext.run(ctx, () => svc.upload('need-1', [file('a.pdf', 'content-a')])),
      ).rejects.toBeInstanceOf(ConflictException);

      // No separate stand-alone count transaction before the locked one — the
      // only evidence.count call happens in the same invocation as the lock.
      const countCall = calls.find((c) => c.op === 'evidence.count');
      const lockCall = calls.find((c) => c.op === 'executeRaw');
      expect(countCall).toBeDefined();
      expect(lockCall).toBeDefined();
      expect(countCall?.txInvocation).toBe(lockCall?.txInvocation);
      // create must never be reached once over capacity.
      expect(calls.some((c) => c.op === 'evidence.create')).toBe(false);
    });
  });

  describe('remove', () => {
    const row: EvidenceRow = {
      id: 'ev-1', needId: 'need-1', studyId: 'study-1', orgId: 'o1', fileName: 'a.pdf', fileType: 'application/pdf',
      fileSize: 10, storageKey: 'key-a', fileHash: 'content-a', uploadedBy: 'me', uploadedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('404s when the evidence does not exist', async () => {
      const svc = makeService(fakeTenant({ evidenceRow: null }));
      await expect(orgContext.run(ctx, () => svc.remove('ev-1'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes when the parent Need is still draft', async () => {
      let deletedWhere: unknown;
      let removedKey: string | undefined;
      const storage = fakeStorage({ onRemove: (k) => { removedKey = k; } });
      const svc = makeService(
        fakeTenant({ evidenceRow: row, need: { studyId: 'study-1', status: 'draft' }, onEvidenceDelete: (w) => { deletedWhere = w; } }),
        storage,
      );
      await orgContext.run(ctx, () => svc.remove('ev-1'));
      expect(deletedWhere).toEqual({ id: 'ev-1' });
      expect(removedKey).toBe('key-a');
    });

    it.each(['evidence_submitted', 'reviewer_approved', 'survey_created', 'survey_published'])(
      // ai_classified deliberately excluded — evidence stays deletable
      // through that stage (see EVIDENCE_EDITABLE_STATUSES's comment); it
      // only locks once an Approver has actually acted (reviewer_approved+).
      '409s once the parent Need is past draft (%s) and never deletes',
      async (status) => {
        let deleted = false;
        let removed = false;
        const storage = fakeStorage({ onRemove: () => { removed = true; } });
        const svc = makeService(
          fakeTenant({ evidenceRow: row, need: { studyId: 'study-1', status }, onEvidenceDelete: () => { deleted = true; } }),
          storage,
        );
        await expect(orgContext.run(ctx, () => svc.remove('ev-1'))).rejects.toBeInstanceOf(ConflictException);
        expect(deleted).toBe(false);
        expect(removed).toBe(false);
      },
    );

    it('does not block deletion when the parent Need cannot be found (defensive branch, should not occur via FK cascade)', async () => {
      let deleted = false;
      const svc = makeService(fakeTenant({ evidenceRow: row, need: null, onEvidenceDelete: () => { deleted = true; } }));
      await orgContext.run(ctx, () => svc.remove('ev-1'));
      expect(deleted).toBe(true);
    });
  });
});
