import { EvidenceStorageService } from './evidence.storage.service';

describe('EvidenceStorageService file signatures', () => {
  const storage = new EvidenceStorageService({ evidenceStoragePath: './tmp' } as never);

  it('accepts matching PDF, JPEG, PNG, and OOXML signatures', () => {
    expect(() => storage.assertFileSignature('a.pdf', Buffer.from('%PDF-1.7'))).not.toThrow();
    expect(() => storage.assertFileSignature('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).not.toThrow();
    expect(() => storage.assertFileSignature('a.png', Buffer.from('89504e470d0a1a0a', 'hex'))).not.toThrow();
    expect(() => storage.assertFileSignature('a.docx', Buffer.from('504b0304', 'hex'))).not.toThrow();
  });

  it('rejects executable content renamed to an allowed extension', () => {
    expect(() => storage.assertFileSignature('malware.pdf', Buffer.from('MZ executable'))).toThrow();
  });
});
