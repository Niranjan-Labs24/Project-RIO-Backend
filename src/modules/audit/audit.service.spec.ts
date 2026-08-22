import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { AuditService } from './audit.service';

function fakeTenant() {
  const rows: Record<string, unknown>[] = [];
  const tenant = {
    runInOrgContext: async (fn: (tx: unknown) => unknown) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
          findUnique: async () => ({
            id: 'a1',
            organisationId: 'o1',
            actorUserId: 'u1',
            action: 'USER_INVITED',
            entityType: 'user',
            entityId: 'u2',
            entityLabel: 'New User',
            metadata: {
              password: 'SecretPassword123!',
              role: 'ngo_admin',
              changes: [{ field: 'password', before: 'oldSecret', after: 'newSecret' }],
            },
            createdAt: new Date(),
          }),
          count: async () => 10,
          findMany: async () => [
            {
              id: 'a1',
              organisationId: 'o1',
              actorUserId: 'u1',
              action: 'ORGANIZATION_DEACTIVATED',
              entityType: 'organization',
              entityId: 'o1',
              entityLabel: 'Demo Org',
              createdAt: new Date(),
            },
          ],
        },
        user: {
          findMany: async () => [{ id: 'u1', name: 'Admin User', email: 'admin@demo.org' }],
        },
      }),
    runAsOrg: async (_orgId: string, fn: (tx: unknown) => unknown) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
        },
      }),
    runAsSupervisor: async (fn: (tx: unknown) => unknown) =>
      fn({
        auditLog: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            rows.push(data);
            return data;
          },
          findUnique: async () => ({
            id: 'a1',
            organisationId: 'o1',
            actorUserId: 'u1',
            action: 'USER_INVITED',
            entityType: 'user',
            entityId: 'u2',
            entityLabel: 'New User',
            metadata: {
              password: 'SecretPassword123!',
              role: 'ngo_admin',
              changes: [{ field: 'password', before: 'oldSecret', after: 'newSecret' }],
            },
            createdAt: new Date(),
          }),
          count: async () => 10,
          findMany: async () => [
            {
              id: 'a1',
              organisationId: 'o1',
              actorUserId: 'u1',
              action: 'ORGANIZATION_DEACTIVATED',
              entityType: 'organization',
              entityId: 'o1',
              entityLabel: 'Demo Org',
              createdAt: new Date(),
            },
          ],
        },
        user: {
          findMany: async () => [{ id: 'u1', name: 'Admin User', email: 'admin@demo.org' }],
        },
      }),
  };
  return { rows, tenant };
}

describe('AuditService', () => {
  it('record writes an append-only row with actor/org/ip/ua', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run(
      { requestId: 'r', orgId: 'o1', actorId: 'u1', ip: '1.2.3.4', userAgent: 'jest' },
      () =>
        svc.record({
          action: 'edit',
          entityType: 'organization',
          entityId: 'o1',
          entityLabel: 'Demo NGO',
          changes: [{ field: 'name', before: 'A', after: 'B' }],
        }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.organisationId).toBe('o1');
    expect(row.actorUserId).toBe('u1');
    expect(row.action).toBe('edit');
  });

  it('record writes sourceRef as a first-class column, not buried in metadata', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run(
      { requestId: 'r', orgId: 'o1', actorId: 'u1', ip: '1.2.3.4', userAgent: 'jest' },
      () =>
        svc.record({
          action: 'create',
          entityType: 'need',
          entityId: 'n1',
          entityLabel: 'Water shortage',
          sourceRef: 'FIELD-FORM-001',
        }),
    );
    expect(rows[0]?.sourceRef).toBe('FIELD-FORM-001');
    expect((rows[0]?.metadata as Record<string, unknown> | undefined)?.sourceRef).toBeUndefined();
  });

  it('record writes sourceRef: null when the entity has none, never omitting the column', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run(
      { requestId: 'r', orgId: 'o1', actorId: 'u1' },
      () => svc.record({ action: 'create', entityType: 'need', entityId: 'n2', entityLabel: 'No reference' }),
    );
    expect(rows[0]?.sourceRef).toBeNull();
  });

  it('getById redacts sensitive password fields in metadata and changes', async () => {
    const { tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    const detail = await orgContext.run(
      { requestId: 'r', actorId: 'u1', role: 'system_admin' },
      () => svc.getById('a1'),
    );

    expect(detail).toBeDefined();
    expect(detail.metadata?.password).toBe('[REDACTED]');
    expect(detail.changes?.[0]?.before).toBe('[REDACTED]');
    expect(detail.changes?.[0]?.after).toBe('[REDACTED]');
  });

  it('getSummary aggregates governance metrics', async () => {
    const { tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    const summary = await orgContext.run(
      { requestId: 'r', actorId: 'u1', role: 'system_admin' },
      () => svc.getSummary(),
    );

    expect(summary).toBeDefined();
    expect(summary.stats.totalEvents).toBe(10);
    expect(summary.recentDeactivatedOrgs).toHaveLength(1);
  });
});

// ── RIO-FR-007 AC1: before/after values survive the round trip ────────────
//
// The requirement is not just "an event was logged" but that the *decision*
// is reconstructable — actor, time, and what changed from what. `changes` is
// stored inside the metadata JSON and lifted back out on read, so the write
// and the read shape are pinned separately.

describe('AuditService before/after values (RIO-FR-007)', () => {
  it('record folds changes[] into metadata so the before/after pair is persisted', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({
        action: 'edit',
        entityType: 'need',
        entityId: 'n1',
        entityLabel: 'Water shortage',
        changes: [
          { field: 'status', before: 'draft', after: 'need_captured' },
          { field: 'severity', before: 2, after: 4 },
        ],
      }),
    );

    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata.changes).toEqual([
      { field: 'status', before: 'draft', after: 'need_captured' },
      { field: 'severity', before: 2, after: 4 },
    ]);
  });

  it('keeps caller metadata alongside changes rather than replacing it', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({
        action: 'approve',
        entityType: 'report',
        entityId: 'rep1',
        entityLabel: 'Q1 Report',
        metadata: { step: 'confirm' },
        changes: [{ field: 'status', before: 'pending', after: 'released' }],
      }),
    );

    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata.step).toBe('confirm');
    expect(Array.isArray(metadata.changes)).toBe(true);
  });

  it('writes no metadata column at all when there is nothing to record', async () => {
    // An empty `{}` would make every event look like it carried context.
    // The entityId here is a real UUID on purpose: entity_id is a uuid
    // column, and record() now parks a non-UUID id in metadata rather than
    // letting Postgres reject the whole row (see the invalid-entityId tests
    // below), which would otherwise populate the very metadata this asserts
    // is absent.
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({ action: 'login', entityType: 'user', entityId: '019fb681-12e8-7421-ad6a-c440aa998d8f', entityLabel: 'Demo Admin', changes: [] }),
    );

    expect(rows[0]?.metadata).toBeUndefined();
  });

  it('records the acting user and the affected org, not the actor\'s own org, on cross-org admin actions', async () => {
    // System Admin acting on another org: the event has to be findable under
    // the org it affected, while still naming the admin who did it.
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.record({
        action: 'ORGANIZATION_DEACTIVATED',
        entityType: 'organization',
        entityId: 'o9',
        entityLabel: 'Other NGO',
        organizationId: 'o9',
      }),
    );

    expect(rows[0]?.organisationId).toBe('o9');
    expect(rows[0]?.actorUserId).toBe('sa1');
  });

  it('never lets an audit-write failure break the request it was recording', async () => {
    // Auditing is append-only bookkeeping around a primary write; if the
    // insert fails the user's action must still succeed.
    const exploding = {
      runAsOrg: async () => {
        throw new Error('db down');
      },
      runAsSupervisor: async () => {
        throw new Error('db down');
      },
    };
    const svc = new AuditService(exploding as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
        svc.record({ action: 'create', entityType: 'need', entityId: 'n1', entityLabel: 'X' }),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── Query surface: filters, pagination, and the CSV export ────────────────

interface QueryCall {
  where: Record<string, unknown>;
  take: number;
  skip: number;
}

const LOG_ROW = {
  id: 'a1',
  organisationId: 'o1',
  actorUserId: 'u1',
  action: 'approve',
  entityType: 'need',
  entityId: 'n1',
  entityLabel: 'Water shortage, "North" village',
  metadata: { changes: [{ field: 'status', before: 'draft', after: 'approved' }] },
  sourceRef: 'FIELD-FORM-001',
  ipAddress: '10.0.0.1',
  userAgent: 'vitest',
  createdAt: new Date('2026-08-06T10:00:00Z'),
};

function queryTenant(logs: Record<string, unknown>[] = [LOG_ROW]) {
  const calls: QueryCall[] = [];
  const used: string[] = [];
  const tx = {
    auditLog: {
      findMany: async (args: QueryCall) => (calls.push(args), logs),
      count: async () => logs.length,
    },
    user: {
      findMany: async () => [{ id: 'u1', name: 'Admin User', email: 'admin@demo.org' }],
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => (used.push('org'), fn(tx)),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => (used.push('supervisor'), fn(tx)),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  return { tenant, calls, used };
}

describe('AuditService.list filters and pagination', () => {
  it('passes every supplied filter through to the query', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({
        entityType: 'need',
        entityId: 'n1',
        actorId: 'u1',
        action: 'approve',
        sourceRef: 'FIELD-FORM-001',
      }),
    );

    expect(calls[0]?.where).toMatchObject({
      entityType: 'need',
      entityId: 'n1',
      actorUserId: 'u1',
      action: 'approve',
      sourceRef: 'FIELD-FORM-001',
    });
  });

  it('turns dateFrom/dateTo into an inclusive createdAt range', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ dateFrom: '2026-08-01T00:00:00Z', dateTo: '2026-08-31T23:59:59Z' }),
    );

    expect(calls[0]?.where.createdAt).toEqual({
      gte: new Date('2026-08-01T00:00:00Z'),
      lte: new Date('2026-08-31T23:59:59Z'),
    });
  });

  it('omits a filter entirely when it was not supplied', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ entityType: 'need' }),
    );

    expect(calls[0]?.where).toEqual({ entityType: 'need' });
  });

  // Absent → the 50 default; anything supplied is floored at 1 and capped at
  // 200, so neither `?limit=0` (which would return an empty page forever) nor
  // `?limit=100000` (which would pull the whole log in one request) is
  // reachable from the client.
  it.each([
    [undefined, 50],
    [10, 10],
    [200, 200],
    [500, 200],
    [0, 1],
    [-5, 1],
  ])('clamps limit %s to %s so one request cannot pull the whole log', async (given, expected) => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ limit: given }),
    );

    expect(calls[0]?.take).toBe(expected);
    expect(result.limit).toBe(expected);
  });

  it('never applies a negative offset', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ offset: -20 }),
    );

    expect(calls[0]?.skip).toBe(0);
  });

  it('returns total independently of the page size, for page counts', async () => {
    const { tenant } = queryTenant([LOG_ROW, { ...LOG_ROW, id: 'a2' }, { ...LOG_ROW, id: 'a3' }]);
    const svc = new AuditService(tenant as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ limit: 1 }),
    );

    expect(result.total).toBe(3);
    expect(result.limit).toBe(1);
  });

  it('resolves the actor onto each event so the log names a person, not an id', async () => {
    const { tenant } = queryTenant();
    const svc = new AuditService(tenant as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({}),
    );

    expect(result.items[0]?.actor).toEqual({ id: 'u1', name: 'Admin User', email: 'admin@demo.org' });
    expect(result.items[0]?.createdAt).toBe('2026-08-06T10:00:00.000Z');
  });

  it('lifts changes out of metadata onto the event', async () => {
    const { tenant } = queryTenant();
    const svc = new AuditService(tenant as never);
    const result = await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({}),
    );

    expect(result.items[0]?.changes).toEqual([{ field: 'status', before: 'draft', after: 'approved' }]);
    // ...and does not leave a duplicate copy behind in metadata.
    expect(result.items[0]?.metadata?.changes).toBeUndefined();
  });
});

describe('AuditService.list org scoping by role', () => {
  it('reads within the caller org for a single-entity role, ignoring a requested organizationId', async () => {
    const { tenant, used, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1', role: 'ngo_admin' }, () =>
      svc.list({ organizationId: 'someone-elses-org' }),
    );

    expect(used).toContain('org');
    expect(calls[0]?.where.organisationId).toBeUndefined();
  });

  it('reads across orgs for a cross-entity role, and can narrow to one org', async () => {
    const { tenant, used, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.list({ organizationId: 'o9' }),
    );

    expect(used).toContain('supervisor');
    expect(calls[0]?.where.organisationId).toBe('o9');
  });
});

describe('AuditService.exportCsv (RIO-FR-007 — System Admin download)', () => {
  it('emits the header row plus one row per event', async () => {
    const { tenant } = queryTenant([LOG_ROW, { ...LOG_ROW, id: 'a2' }]);
    const svc = new AuditService(tenant as never);
    const csv = await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({}),
    );

    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Timestamp","Actor","Action","Entity Type","Entity","IP Address"');
    expect(lines).toHaveLength(3);
  });

  it('quotes every field and escapes embedded quotes, so a label cannot break the columns', async () => {
    const { tenant } = queryTenant();
    const svc = new AuditService(tenant as never);
    const csv = await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({}),
    );

    // entityLabel contains both a comma and double quotes.
    expect(csv).toContain('"Water shortage, ""North"" village"');
  });

  it('exports the actor email and timestamp, the two fields the audit is for', async () => {
    const { tenant } = queryTenant();
    const svc = new AuditService(tenant as never);
    const csv = await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({}),
    );

    expect(csv).toContain('"admin@demo.org"');
    expect(csv).toContain('"2026-08-06T10:00:00.000Z"');
  });

  it('applies the same filters as list()', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({ action: 'approve', entityType: 'need' }),
    );

    expect(calls[0]?.where).toMatchObject({ action: 'approve', entityType: 'need' });
  });

  it('caps the export at 5000 rows rather than streaming the entire table', async () => {
    const { tenant, calls } = queryTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({}),
    );

    expect(calls[0]?.take).toBe(5000);
    expect(calls[0]?.skip).toBe(0);
  });

  it('returns just the header when nothing matches, never an empty body', async () => {
    const { tenant } = queryTenant([]);
    const svc = new AuditService(tenant as never);
    const csv = await orgContext.run({ requestId: 'r', orgId: 'admin-org', actorId: 'sa1', role: 'system_admin' }, () =>
      svc.exportCsv({ action: 'nothing-matches' }),
    );

    expect(csv).toBe('"Timestamp","Actor","Action","Entity Type","Entity","IP Address"');
  });

  // RIO-FR-007 AC1 regression — audit_logs.entity_id is a uuid column, so a
  // sentinel like 'all' made Postgres reject the INSERT and record()'s catch
  // swallowed it: every cross-org "System Admin viewed X" event was silently
  // going unrecorded in production while the request itself returned 200.
  it('parks a non-UUID entityId in metadata instead of losing the whole event', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({
        action: 'SYSTEM_ADMIN_VIEWED_STUDIES',
        entityType: 'study',
        entityId: 'all',
        entityLabel: 'All Platform Studies',
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toBeNull();
    expect(rows[0]?.metadata).toMatchObject({ invalidEntityId: 'all' });
    // The event itself survives — that is the whole point.
    expect(rows[0]?.action).toBe('SYSTEM_ADMIN_VIEWED_STUDIES');
    expect(rows[0]?.entityLabel).toBe('All Platform Studies');
  });

  it('passes a real UUID entityId through untouched', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    const id = '019fb681-12e8-7421-ad6a-c440aa998d8f';
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({ action: 'edit', entityType: 'study', entityId: id, entityLabel: 'A Study' }),
    );

    expect(rows[0]?.entityId).toBe(id);
    expect(rows[0]?.metadata).toBeUndefined();
  });

  it('keeps a null entityId null, with no metadata noise', async () => {
    const { rows, tenant } = fakeTenant();
    const svc = new AuditService(tenant as never);
    await orgContext.run({ requestId: 'r', orgId: 'o1', actorId: 'u1' }, () =>
      svc.record({
        action: 'SYSTEM_ADMIN_VIEWED_SURVEY',
        entityType: 'survey',
        entityId: null,
        entityLabel: 'All Platform Surveys',
      }),
    );

    expect(rows[0]?.entityId).toBeNull();
    expect(rows[0]?.metadata).toBeUndefined();
  });

  it('recordWithTx propagates a write failure instead of swallowing it (GAP-11)', async () => {
    const tx = { auditLog: { create: vi.fn().mockRejectedValue(new Error('insert failed')) } };
    const svc = new AuditService(fakeTenant() as never);
    await orgContext.run(
      { requestId: 'r1', orgId: 'org1', role: 'ngo_admin' },
      async () => {
        await expect(
          svc.recordWithTx(tx as never, {
            action: 'create', entityType: 'survey_response',
            entityId: '00000000-0000-0000-0000-000000000abc',
            entityLabel: 'x', organizationId: 'org1',
          }),
        ).rejects.toThrow('insert failed');
      },
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });
});
