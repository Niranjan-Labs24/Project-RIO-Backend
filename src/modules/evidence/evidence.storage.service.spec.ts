import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStorageService } from './evidence.storage.service';

function makeService() {
  // hashBuffer does no I/O and config isn't touched by it, so a real
  // ConfigService isn't needed for these tests.
  return new EvidenceStorageService(undefined as never);
}

// remove() does real fs I/O (unlink), so these tests need a real directory
// and a fake ConfigService pointing evidenceStoragePath at it — mirrors the
// mkdtempSync pattern in src/config/https-options.spec.ts.
function makeServiceWithStorageDir(dir: string) {
  return new EvidenceStorageService({ evidenceStoragePath: dir } as never);
}

describe('EvidenceStorageService', () => {
  describe('hashBuffer', () => {
    it('returns the hex-encoded sha256 digest of the buffer', () => {
      const svc = makeService();
      const buffer = Buffer.from('hello evidence');
      const expected = createHash('sha256').update(buffer).digest('hex');
      expect(svc.hashBuffer(buffer)).toBe(expected);
      expect(svc.hashBuffer(buffer)).toHaveLength(64);
    });

    it('is deterministic for identical content', () => {
      const svc = makeService();
      const a = svc.hashBuffer(Buffer.from('same content'));
      const b = svc.hashBuffer(Buffer.from('same content'));
      expect(a).toBe(b);
    });

    it('differs for different content', () => {
      const svc = makeService();
      const a = svc.hashBuffer(Buffer.from('content A'));
      const b = svc.hashBuffer(Buffer.from('content B'));
      expect(a).not.toBe(b);
    });
  });

  // GAP-13: remove() used to swallow unlink failures with
  // `.catch(() => undefined)`, always resolving as if the delete succeeded
  // even when the file was left on disk. It must now surface failure to the
  // caller instead of silently pretending success.
  describe('remove', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'evidence-storage-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('deletes an existing file and resolves true', async () => {
      const key = 'a1111111-1111-1111-1111-111111111111.pdf';
      writeFileSync(join(dir, key), 'content');
      const svc = makeServiceWithStorageDir(dir);

      const result = await svc.remove(key);

      expect(result).toBe(true);
      expect(existsSync(join(dir, key))).toBe(false);
    });

    it('surfaces failure instead of silently swallowing it when the file does not exist', async () => {
      const key = 'a2222222-2222-2222-2222-222222222222.pdf';
      const svc = makeServiceWithStorageDir(dir);

      const result = await svc.remove(key);

      // Previously this resolved undefined (swallowed) no matter what
      // happened on disk. It must now report the failure rather than
      // looking identical to a successful delete.
      expect(result).toBe(false);
    });
  });
});
