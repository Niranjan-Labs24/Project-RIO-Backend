import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHttpsOptions } from './https-options';

describe('buildHttpsOptions', () => {
  it('returns undefined unless both cert and key paths are set', () => {
    expect(buildHttpsOptions(undefined, undefined)).toBeUndefined();
    expect(buildHttpsOptions('cert.pem', undefined)).toBeUndefined();
    expect(buildHttpsOptions(undefined, 'key.pem')).toBeUndefined();
  });

  it('reads the cert and key files when both paths are set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-'));
    const certPath = join(dir, 'server.crt');
    const keyPath = join(dir, 'server.key');
    writeFileSync(certPath, 'CERT-CONTENT');
    writeFileSync(keyPath, 'KEY-CONTENT');
    try {
      const opts = buildHttpsOptions(certPath, keyPath);
      expect(opts).toBeDefined();
      expect(opts!.cert.toString()).toBe('CERT-CONTENT');
      expect(opts!.key.toString()).toBe('KEY-CONTENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
