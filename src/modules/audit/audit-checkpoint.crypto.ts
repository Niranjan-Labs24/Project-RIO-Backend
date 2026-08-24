import { createHash, createHmac } from 'node:crypto';

export interface CheckpointRow {
  id: string; organisationId: string | null; actorUserId: string | null;
  action: string; entityType: string; entityId: string | null; entityLabel: string;
  sourceRef: string | null; metadata: unknown; ipAddress: string | null;
  userAgent: string | null; createdAt: Date;
}

// Deterministic, key-order-insensitive JSON for a row's material fields.
export function canonicalizeRow(r: CheckpointRow): string {
  const ordered = {
    id: r.id, organisationId: r.organisationId, actorUserId: r.actorUserId,
    action: r.action, entityType: r.entityType, entityId: r.entityId,
    entityLabel: r.entityLabel, sourceRef: r.sourceRef,
    metadata: stableStringify(r.metadata), ipAddress: r.ipAddress,
    userAgent: r.userAgent, createdAt: r.createdAt.toISOString(),
  };
  return stableStringify(ordered);
}

export function computeDigest(rows: CheckpointRow[]): string {
  const h = createHash('sha256');
  for (const r of rows) h.update(canonicalizeRow(r)).update('\n');
  return h.digest('hex');
}

/** Chain link: HMAC(signingKey, (prevChainHash ?? '') + ':' + digest). */
export function chainSign(prevChainHash: string | null, digest: string, signingKeyB64: string): string {
  const key = Buffer.from(signingKeyB64, 'base64');
  return createHmac('sha256', key).update(`${prevChainHash ?? ''}:${digest}`).digest('hex');
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
