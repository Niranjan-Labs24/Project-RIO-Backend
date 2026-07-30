import { createHash } from 'node:crypto';
import { EvidenceStorageService } from './evidence.storage.service';

function makeService() {
  // hashBuffer does no I/O and config isn't touched by it, so a real
  // ConfigService isn't needed for these tests.
  return new EvidenceStorageService(undefined as never);
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
});
