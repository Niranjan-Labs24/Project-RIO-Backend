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
  need?: unknown | null;
  existingEvidenceCount?: number;
  existingHashes?: string[];
  study?: { status: string } | null;
  evidenceRow?: EvidenceRow | null;
  onEvidenceCreate?: (data: Record<string, unknown>) => void;
  onEvidenceDelete?: (where: unknown) => void;
  users?: { id: string; name: string }[];
}) {
  let idCounter = 0;
  const tx = {
    need: { findUnique: async () => opts.need ?? null },
    evidence: {
      count: async () => opts.existingEvidenceCount ?? 0,
      findMany: async (args?: { select?: { fileHash?: boolean } }) => {
        if (args?.select?.fileHash) {
          return (opts.existingHashes ?? []).map((h) => ({ fileHash: h }));
        }
        return [];
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        idCounter += 1;
        opts.onEvidenceCreate?.(data);
        return { id: `ev-${idCounter}`, uploadedAt: new Date('2026-01-01T00:00:00Z'), ...data };
      },
      findUnique: async () => opts.evidenceRow ?? null,
      delete: async ({ where }: { where: unknown }) => {
        opts.onEvidenceDelete?.(where);
      },
    },
    study: {
      findUnique: async () => opts.study ?? null,
    },
    user: {
      findMany: async () => opts.users ?? [],
    },
  };
  return { runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(tx) };
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
    it('404s when the study has no need yet', async () => {
      const svc = makeService(fakeTenant({ need: null }));
      await expect(
        orgContext.run(ctx, () => svc.upload('study-1', [file('a.pdf', 'content-a')])),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('409s when the upload would exceed the per-study file limit', async () => {
      const svc = makeService(fakeTenant({ need: {}, existingEvidenceCount: MAX_EVIDENCE_FILES_PER_STUDY }));
      await expect(
        orgContext.run(ctx, () => svc.upload('study-1', [file('a.pdf', 'content-a')])),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('computes and persists fileHash from the in-memory buffer', async () => {
      let created: Record<string, unknown> | undefined;
      const svc = makeService(
        fakeTenant({ need: {}, onEvidenceCreate: (d) => { created = d; } }),
      );
      await orgContext.run(ctx, () => svc.upload('study-1', [file('a.pdf', 'content-a')]));
      expect(created?.fileHash).toBe('content-a');
    });

    it('flags isDuplicate=false for the first upload of a new hash', async () => {
      const svc = makeService(fakeTenant({ need: {} }));
      const [evidence] = await orgContext.run(ctx, () => svc.upload('study-1', [file('a.pdf', 'content-a')]));
      expect(evidence.isDuplicate).toBe(false);
    });

    it('flags isDuplicate=true when the hash already exists in the study', async () => {
      const svc = makeService(fakeTenant({ need: {}, existingHashes: ['content-a'] }));
      const [evidence] = await orgContext.run(ctx, () => svc.upload('study-1', [file('a.pdf', 'content-a')]));
      expect(evidence.isDuplicate).toBe(true);
    });

    it('flags the second copy of the same file within one batch, but not the first', async () => {
      const svc = makeService(fakeTenant({ need: {} }));
      const [first, second] = await orgContext.run(ctx, () =>
        svc.upload('study-1', [file('a.pdf', 'same-content'), file('b.pdf', 'same-content')]),
      );
      expect(first.isDuplicate).toBe(false);
      expect(second.isDuplicate).toBe(true);
    });

    it('does not flag two different files as duplicates of each other', async () => {
      const svc = makeService(fakeTenant({ need: {} }));
      const [first, second] = await orgContext.run(ctx, () =>
        svc.upload('study-1', [file('a.pdf', 'content-a'), file('b.pdf', 'content-b')]),
      );
      expect(first.isDuplicate).toBe(false);
      expect(second.isDuplicate).toBe(false);
    });
  });

  describe('remove', () => {
    const row: EvidenceRow = {
      id: 'ev-1', studyId: 'study-1', orgId: 'o1', fileName: 'a.pdf', fileType: 'application/pdf',
      fileSize: 10, storageKey: 'key-a', fileHash: 'content-a', uploadedBy: 'me', uploadedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('404s when the evidence does not exist', async () => {
      const svc = makeService(fakeTenant({ evidenceRow: null }));
      await expect(orgContext.run(ctx, () => svc.remove('ev-1'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(['draft', 'need_captured'])('deletes when the parent Study is still %s', async (status) => {
      let deletedWhere: unknown;
      let removedKey: string | undefined;
      const storage = fakeStorage({ onRemove: (k) => { removedKey = k; } });
      const svc = makeService(
        fakeTenant({ evidenceRow: row, study: { status }, onEvidenceDelete: (w) => { deletedWhere = w; } }),
        storage,
      );
      await orgContext.run(ctx, () => svc.remove('ev-1'));
      expect(deletedWhere).toEqual({ id: 'ev-1' });
      expect(removedKey).toBe('key-a');
    });

    it.each(['evidence_submitted', 'ai_classified', 'human_reviewed'])(
      '409s once the parent Study is past need_captured (%s) and never deletes',
      async (status) => {
        let deleted = false;
        let removed = false;
        const storage = fakeStorage({ onRemove: () => { removed = true; } });
        const svc = makeService(
          fakeTenant({ evidenceRow: row, study: { status }, onEvidenceDelete: () => { deleted = true; } }),
          storage,
        );
        await expect(orgContext.run(ctx, () => svc.remove('ev-1'))).rejects.toBeInstanceOf(ConflictException);
        expect(deleted).toBe(false);
        expect(removed).toBe(false);
      },
    );

    it('does not block deletion when the parent Study cannot be found (defensive branch, should not occur via FK cascade)', async () => {
      let deleted = false;
      const svc = makeService(fakeTenant({ evidenceRow: row, study: null, onEvidenceDelete: () => { deleted = true; } }));
      await orgContext.run(ctx, () => svc.remove('ev-1'));
      expect(deleted).toBe(true);
    });
  });
});
