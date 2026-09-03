import { orgContext, requireOrgId } from '../../tenancy/org-context';
import { InitiativesService } from './initiatives.service';

interface FakeInitiative {
  id: string;
  orgId: string;
  name: string;
  domain: string | null;
  geography: string | null;
  startDate: Date | null;
  expectedEndDate: Date | null;
  status: string;
  fundingSource: string | null;
  description: string | null;
  budget: number | null;
  openToOtherEntities: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeNeed {
  id: string;
  orgId: string;
  analyticalStatus: string;
}
interface FakeLink {
  needId: string;
  initiativeId: string;
  orgId: string;
  linkedBy: string;
  linkedAt: Date;
}
interface FakeStatusEvent {
  id: string;
  needId: string;
  orgId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string | null;
  changedAt: Date;
  note: string | null;
}

// A single fake tenant, mirroring sharing.service.spec.ts's own fakeTenant
// shape — the RLS visibility rule (own org OR openToOtherEntities) is
// reproduced here in plain JS since there's no real Postgres in this test.
function fakeTenant(seed: {
  initiatives?: FakeInitiative[];
  needs?: FakeNeed[];
  orgs?: Array<{ id: string; name: string }>;
}) {
  const initiatives = [...(seed.initiatives ?? [])];
  const needs = [...(seed.needs ?? [])];
  const orgs = seed.orgs ?? [];
  const links: FakeLink[] = [];
  const statusEvents: FakeStatusEvent[] = [];
  let seq = 0;

  function visibleTo(orgId: string) {
    return initiatives.filter((i) => i.orgId === orgId || i.openToOtherEntities);
  }

  function makeTx(callerOrgId: string) {
    return {
      initiative: {
        findMany: async (args?: { where?: { id?: { in: string[] } } }) => {
          const visible = visibleTo(callerOrgId);
          const ids = args?.where?.id?.in;
          return ids ? visible.filter((i) => ids.includes(i.id)) : visible;
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const row = initiatives.find((i) => i.id === where.id);
          if (!row) return null;
          return visibleTo(callerOrgId).some((v) => v.id === row.id) ? row : null;
        },
        create: async ({ data }: { data: Partial<FakeInitiative> }) => {
          const row: FakeInitiative = {
            id: `init-${++seq}`,
            orgId: data.orgId!,
            name: data.name!,
            domain: data.domain ?? null,
            geography: data.geography ?? null,
            startDate: (data.startDate as Date) ?? null,
            expectedEndDate: (data.expectedEndDate as Date) ?? null,
            status: data.status ?? 'active',
            fundingSource: data.fundingSource ?? null,
            description: data.description ?? null,
            budget: (data.budget as number) ?? null,
            openToOtherEntities: data.openToOtherEntities ?? false,
            createdBy: data.createdBy!,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          initiatives.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Partial<FakeInitiative> }) => {
          const idx = initiatives.findIndex((i) => i.id === where.id && i.orgId === callerOrgId);
          if (idx === -1) return { count: 0 } as never; // RLS WITH CHECK: no matching row, no-op
          initiatives[idx] = { ...initiatives[idx], ...data } as FakeInitiative;
          return initiatives[idx];
        },
      },
      need: {
        findUnique: async ({ where }: { where: { id: string } }) => needs.find((n) => n.id === where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<FakeNeed> }) => {
          const idx = needs.findIndex((n) => n.id === where.id);
          needs[idx] = { ...needs[idx], ...data } as FakeNeed;
          return needs[idx];
        },
      },
      needInitiative: {
        upsert: async ({ create }: { create: FakeLink }) => {
          const existing = links.find((l) => l.needId === create.needId && l.initiativeId === create.initiativeId);
          if (existing) return existing;
          links.push(create);
          return create;
        },
        deleteMany: async ({ where }: { where: { needId: string; initiativeId: string } }) => {
          const before = links.length;
          for (let i = links.length - 1; i >= 0; i--) {
            if (links[i]!.needId === where.needId && links[i]!.initiativeId === where.initiativeId) links.splice(i, 1);
          }
          return { count: before - links.length };
        },
        count: async ({ where }: { where: { needId: string } }) => links.filter((l) => l.needId === where.needId).length,
        findMany: async ({ where }: { where: { needId: string } }) =>
          links.filter((l) => l.needId === where.needId).map((l) => ({ initiativeId: l.initiativeId })),
        groupBy: async ({ where }: { where: { initiativeId: { in: string[] } } }) => {
          const counts = new Map<string, number>();
          for (const l of links) {
            if (!where.initiativeId.in.includes(l.initiativeId)) continue;
            counts.set(l.initiativeId, (counts.get(l.initiativeId) ?? 0) + 1);
          }
          return Array.from(counts.entries()).map(([initiativeId, count]) => ({ initiativeId, _count: count }));
        },
      },
      needAnalyticalStatusEvent: {
        create: async ({ data }: { data: Omit<FakeStatusEvent, 'id' | 'changedAt'> }) => {
          const row: FakeStatusEvent = { id: `ev-${++seq}`, changedAt: new Date(), ...data };
          statusEvents.push(row);
          return row;
        },
        findMany: async ({ where }: { where: { needId: string } }) =>
          statusEvents.filter((e) => e.needId === where.needId),
      },
      organisation: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          orgs.filter((o) => where.id.in.includes(o.id)),
      },
    };
  }

  return {
    initiatives,
    needs,
    links,
    statusEvents,
    runInOrgContext: async (fn: (tx: unknown) => unknown) => fn(makeTx(requireOrgId())),
    runAsSupervisor: async (fn: (tx: unknown) => unknown) => fn(makeTx('__supervisor__')),
  };
}

function fakeAudit() {
  const calls: Array<{ action: string; entityType: string; entityLabel: string }> = [];
  return { calls, record: async (input: (typeof calls)[number]) => { calls.push(input); } };
}

function runAsOrg<T>(orgId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: 'r', orgId, actorId }, fn);
}

const ORGS = [
  { id: 'org-a', name: 'Org A' },
  { id: 'org-b', name: 'Org B' },
];

describe('InitiativesService.create/list — visibility (RIO-FR-009, Q15)', () => {
  it('an initiative not marked open is invisible to another org', async () => {
    const tenant = fakeTenant({ orgs: ORGS });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Well rehabilitation programme' }));

    const seenByOwner = await runAsOrg('org-a', 'user-1', () => svc.list());
    const seenByOther = await runAsOrg('org-b', 'user-2', () => svc.list());
    expect(seenByOwner).toHaveLength(1);
    expect(seenByOther).toHaveLength(0);
  });

  it('an initiative marked open is visible to every org, read-only for others', async () => {
    const tenant = fakeTenant({ orgs: ORGS });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const created = await runAsOrg('org-a', 'user-1', () =>
      svc.create({ name: 'Shared water programme', openToOtherEntities: true }),
    );

    const seenByOther = await runAsOrg('org-b', 'user-2', () => svc.list());
    expect(seenByOther).toHaveLength(1);
    expect(seenByOther[0]!.id).toBe(created.id);

    // The other org still cannot edit it — RLS's WITH CHECK on UPDATE only
    // matches the owning org, so this must not silently succeed.
    await expect(
      runAsOrg('org-b', 'user-2', () => svc.update(created.id, { name: 'Hijacked name' })),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });
  });

  it('rejects an expected end date before the start date', async () => {
    const tenant = fakeTenant({ orgs: ORGS });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    await expect(
      runAsOrg('org-a', 'user-1', () =>
        svc.create({ name: 'Bad dates', startDate: '2027-06-01', expectedEndDate: '2027-01-01' }),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_DATE_RANGE' } } });
  });

  it('creating writes an audit entry', async () => {
    const audit = fakeAudit();
    const tenant = fakeTenant({ orgs: ORGS });
    const svc = new InitiativesService(tenant as never, audit as never);
    await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Literacy drive' }));
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({ action: 'create', entityType: 'initiative' });
  });
});

describe('InitiativesService — linking a Need (RIO-FR-009, Q17/Q18)', () => {
  function seedNeed(): FakeNeed {
    return { id: 'need-1', orgId: 'org-a', analyticalStatus: 'open_gap' };
  }

  it('linking sets the Need to linked_to_initiative and logs a status event with an actor', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [seedNeed()] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const initiative = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));

    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', initiative.id));

    expect(tenant.needs[0]!.analyticalStatus).toBe('linked_to_initiative');
    expect(tenant.links).toHaveLength(1);
    const history = await runAsOrg('org-a', 'user-2', () => svc.listAnalyticalStatusHistory('need-1'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'open_gap', toStatus: 'linked_to_initiative', changedBy: 'user-2' });
  });

  it('linking the same pair twice does not duplicate the link or re-log the status change', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [seedNeed()] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const initiative = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));

    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', initiative.id));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', initiative.id));

    expect(tenant.links).toHaveLength(1);
    expect(tenant.statusEvents).toHaveLength(1);
  });

  it('a Need can link to several Initiatives (Q18: many-to-many)', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [seedNeed()] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const first = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));
    const second = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Clinic upgrade' }));

    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', first.id));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', second.id));

    expect(tenant.links).toHaveLength(2);
  });

  it('unlinking the last remaining link reverts the Need to open_gap', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [seedNeed()] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const initiative = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', initiative.id));

    await runAsOrg('org-a', 'user-3', () => svc.unlinkNeed('need-1', initiative.id));

    expect(tenant.links).toHaveLength(0);
    expect(tenant.needs[0]!.analyticalStatus).toBe('open_gap');
    const history = await runAsOrg('org-a', 'user-3', () => svc.listAnalyticalStatusHistory('need-1'));
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ fromStatus: 'linked_to_initiative', toStatus: 'open_gap', changedBy: 'user-3' });
  });

  it('unlinking one of several links keeps the Need linked_to_initiative', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [seedNeed()] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const first = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));
    const second = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Clinic upgrade' }));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', first.id));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', second.id));

    await runAsOrg('org-a', 'user-3', () => svc.unlinkNeed('need-1', first.id));

    expect(tenant.links).toHaveLength(1);
    expect(tenant.needs[0]!.analyticalStatus).toBe('linked_to_initiative');
  });

  it('unlinking never downgrades a Need already documented_in_study (sticky milestone)', async () => {
    const need: FakeNeed = { id: 'need-1', orgId: 'org-a', analyticalStatus: 'documented_in_study' };
    const tenant = fakeTenant({ orgs: ORGS, needs: [need] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const initiative = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));
    // Link bypassed via direct seed since it's already past linked_to_initiative in this scenario.
    tenant.links.push({ needId: 'need-1', initiativeId: initiative.id, orgId: 'org-a', linkedBy: 'user-1', linkedAt: new Date() });

    await runAsOrg('org-a', 'user-3', () => svc.unlinkNeed('need-1', initiative.id));

    expect(tenant.needs[0]!.analyticalStatus).toBe('documented_in_study');
  });
});

describe('InitiativesService.listLinkedInitiatives', () => {
  it('returns only the initiatives actually linked to this Need, not every visible one', async () => {
    const need = { id: 'need-1', orgId: 'org-a', analyticalStatus: 'open_gap' };
    const tenant = fakeTenant({ orgs: ORGS, needs: [need] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);
    const linked = await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Road repair' }));
    await runAsOrg('org-a', 'user-1', () => svc.create({ name: 'Unrelated initiative' }));
    await runAsOrg('org-a', 'user-2', () => svc.linkNeed('need-1', linked.id));

    const result = await runAsOrg('org-a', 'user-2', () => svc.listLinkedInitiatives('need-1'));

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(linked.id);
  });

  it('returns an empty array when the Need has no links', async () => {
    const tenant = fakeTenant({ orgs: ORGS, needs: [{ id: 'need-1', orgId: 'org-a', analyticalStatus: 'open_gap' }] });
    const svc = new InitiativesService(tenant as never, fakeAudit() as never);

    const result = await runAsOrg('org-a', 'user-1', () => svc.listLinkedInitiatives('need-1'));

    expect(result).toEqual([]);
  });
});
