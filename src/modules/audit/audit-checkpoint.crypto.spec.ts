import { describe, expect, it } from 'vitest';
import { canonicalizeRow, computeDigest, chainSign, type CheckpointRow } from './audit-checkpoint.crypto';

const KEY = Buffer.alloc(32, 5).toString('base64');
const rows = [
  { id: 'a', organisationId: 'o1', actorUserId: null, action: 'create', entityType: 'x', entityId: null, entityLabel: 'L', sourceRef: null, metadata: { a: 1 }, ipAddress: null, userAgent: null, createdAt: new Date('2026-08-24T00:00:00Z') },
  { id: 'b', organisationId: 'o1', actorUserId: 'u', action: 'edit', entityType: 'y', entityId: null, entityLabel: 'M', sourceRef: null, metadata: null, ipAddress: null, userAgent: null, createdAt: new Date('2026-08-24T00:00:01Z') },
] as CheckpointRow[];

describe('audit checkpoint crypto (GAP-02)', () => {
  it('digest is stable and order-sensitive', () => {
    expect(computeDigest(rows)).toBe(computeDigest(rows));
    expect(computeDigest(rows)).not.toBe(computeDigest([rows[1]!, rows[0]!]));
  });
  it('digest changes if any covered row changes (tamper detection)', () => {
    const tampered = [{ ...rows[0], entityLabel: 'HACKED' }, rows[1]];
    expect(computeDigest(tampered as CheckpointRow[])).not.toBe(computeDigest(rows));
  });
  it('chain signature depends on prev hash and digest', () => {
    const d = computeDigest(rows);
    const s1 = chainSign(null, d, KEY);           // genesis
    const s2 = chainSign(s1, d, KEY);              // next link, same digest
    expect(s1).not.toBe(s2);
    expect(chainSign(null, d, KEY)).toBe(s1);      // deterministic
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('canonicalizeRow is field-stable regardless of metadata key order', () => {
    const r1 = { ...rows[0], metadata: { a: 1, b: 2 } };
    const r2 = { ...rows[0], metadata: { b: 2, a: 1 } };
    expect(canonicalizeRow(r1 as CheckpointRow)).toBe(canonicalizeRow(r2 as CheckpointRow));
  });
});
