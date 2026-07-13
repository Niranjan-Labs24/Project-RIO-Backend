import { readFileSync } from 'node:fs';

export interface HttpsKeyCert {
  key: Buffer;
  cert: Buffer;
}

// Encryption in transit (RIO-NFR-001): when both a cert and key path are
// configured, the app serves HTTPS directly. Otherwise it returns undefined and
// the app serves HTTP (TLS terminated at an ingress/proxy in front of it).
export function buildHttpsOptions(certPath?: string, keyPath?: string): HttpsKeyCert | undefined {
  if (!certPath || !keyPath) return undefined;
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
