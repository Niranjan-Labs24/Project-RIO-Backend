import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';
import { InitiativesService } from './initiatives.service';

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1' }, fn);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  orgId: 'org-1',
  name: 'Wells',
  domain: 'Water',
  geography: 'North',
  startDate: new Date('2026-01-01T00:00:00Z'),
  expectedEndDate: new Date('2026-12-31T00:00:00Z'),
  status: 'active',
  fundingSource: 'Donor',
  description: 'd',
  budget: 1000,
  currency: 'SAR',
  openToOtherEntities: true,
  createdBy: 'u1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  ...over,
});

function setup() {
  const tx = {
    initiative: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findUnique: vi.fn().mockResolvedValue(row()),
      create: vi.fn().mockResolvedValue(row()),
      update: vi.fn().mockResolvedValue(row()),
    },
    organisation: { findMany: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Acme' }]) },
    needInitiative: {
      groupBy: vi.fn().mockResolvedValue([{ initiativeId: 'i1', _count: 3 }]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([{ initiativeId: 'i1' }]),
    },
    need: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'n1', title: 'A need', analyticalStatus: 'observed' }),
      update: vi.fn(),
    },
    needAnalyticalStatusEvent: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return { tx, audit, svc: new InitiativesService(tenant as never, audit as never) };
}

describe('InitiativesService reads', () => {
  it('lists initiatives with their organization name, dates as days and the number of linked needs', async () => {
    const { svc } = setup();
    expect(await asActor(() => svc.list())).toEqual([
      expect.objectContaining({
        orgName: 'Acme',
        startDate: '2026-01-01',
        expectedEndDate: '2026-12-31',
        budget: '1000',
        linkedNeedCount: 3,
      }),
    ]);
  });

  it('shows an organization id when the name is unknown, empty dates and budget, and zero links', async () => {
    const { svc, tx } = setup();
    tx.initiative.findMany.mockResolvedValue([
      row({ orgId: 'org-x', startDate: null, expectedEndDate: null, budget: null }),
    ]);
    tx.organisation.findMany.mockResolvedValue([]);
    tx.needInitiative.groupBy.mockResolvedValue([]);
    expect((await asActor(() => svc.list()))[0]).toMatchObject({
      orgName: 'org-x',
      startDate: null,
      expectedEndDate: null,
      budget: null,
      linkedNeedCount: 0,
    });
    tx.initiative.findMany.mockResolvedValue([row({ budget: undefined })]);
    expect((await asActor(() => svc.list()))[0]!.budget).toBeNull();
    tx.initiative.findMany.mockResolvedValue([]);
    expect(await asActor(() => svc.list())).toEqual([]);
  });

  it('returns one initiative, or 404s', async () => {
    const { svc, tx } = setup();
    expect((await asActor(() => svc.get('i1'))).id).toBe('i1');
    tx.initiative.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.get('x'))).rejects.toMatchObject({
      response: { error: { code: 'INITIATIVE_NOT_FOUND' } },
    });
  });

  it('lists the initiatives linked to a need', async () => {
    const { svc, tx } = setup();
    expect(await asActor(() => svc.listLinkedInitiatives('n1'))).toHaveLength(1);
    tx.needInitiative.findMany.mockResolvedValue([]);
    expect(await asActor(() => svc.listLinkedInitiatives('n1'))).toEqual([]);
  });
});

describe('InitiativesService create and update', () => {
  it('creates with defaults and audits', async () => {
    const { svc, tx, audit } = setup();
    await asActor(() => svc.create({ name: 'Wells' } as never));
    expect(tx.initiative.create.mock.calls[0]![0].data).toMatchObject({
      status: 'active',
      currency: 'SAR',
      openToOtherEntities: false,
      startDate: null,
      domain: null,
      budget: null,
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }));
  });

  it('creates with every field and validates the dates', async () => {
    const { svc, tx } = setup();
    await asActor(() =>
      svc.create({
        name: 'W',
        domain: 'D',
        geography: 'G',
        startDate: '2026-01-01',
        expectedEndDate: '2026-02-01',
        status: 'planned',
        fundingSource: 'F',
        description: 'x',
        budget: 5,
        currency: 'USD',
        openToOtherEntities: true,
      } as never),
    );
    expect(tx.initiative.create.mock.calls[0]![0].data).toMatchObject({
      status: 'planned',
      currency: 'USD',
      openToOtherEntities: true,
    });
    await expect(
      asActor(() =>
        svc.create({ name: 'W', startDate: '2026-03-01', expectedEndDate: '2026-02-01' } as never),
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_DATE_RANGE' } } });
    await expect(
      asActor(() => svc.create({ name: 'W', startDate: 'soon' } as never)),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
  });

  it('updates only the fields given, and audits', async () => {
    const { svc, tx, audit } = setup();
    await asActor(() => svc.update('i1', { name: 'New' } as never));
    expect(tx.initiative.update.mock.calls[0]![0].data).toEqual({ name: 'New' });
    await asActor(() =>
      svc.update('i1', {
        name: 'N',
        domain: 'D',
        geography: 'G',
        startDate: '2026-01-01',
        expectedEndDate: '2026-02-01',
        status: 'done',
        fundingSource: 'F',
        description: 'x',
        budget: 1,
        currency: 'USD',
        openToOtherEntities: false,
      } as never),
    );
    expect(Object.keys(tx.initiative.update.mock.calls[1]![0].data)).toHaveLength(11);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('lets only the owning organization edit', async () => {
    const { svc, tx } = setup();
    tx.initiative.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.update('x', {} as never))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    tx.initiative.findUnique.mockResolvedValueOnce(row({ orgId: 'org-2' }));
    await expect(asActor(() => svc.update('i1', {} as never))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });
});

describe('InitiativesService linking and analytical status', () => {
  it('links a need to an initiative and moves its status once', async () => {
    const { svc, tx, audit } = setup();
    await asActor(() => svc.linkNeed('n1', 'i1'));
    expect(tx.needInitiative.upsert).toHaveBeenCalled();
    expect(tx.need.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { analyticalStatus: 'linked_to_initiative' },
    });
    expect(tx.needAnalyticalStatusEvent.create).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    tx.need.findUnique.mockResolvedValue({
      id: 'n1',
      title: 'A need',
      analyticalStatus: 'linked_to_initiative',
    });
    tx.need.update.mockClear();
    await asActor(() => svc.linkNeed('n1', 'i1'));
    expect(tx.need.update).not.toHaveBeenCalled();
  });

  it('404s linking an unknown need or initiative', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.linkNeed('x', 'i1'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
    tx.initiative.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.linkNeed('n1', 'x'))).rejects.toMatchObject({
      response: { error: { code: 'INITIATIVE_NOT_FOUND' } },
    });
  });

  it('unlinks, reopening the gap only when it was the last link', async () => {
    const { svc, tx, audit } = setup();
    tx.need.findUnique.mockResolvedValue({
      id: 'n1',
      title: 'A need',
      analyticalStatus: 'linked_to_initiative',
    });
    await asActor(() => svc.unlinkNeed('n1', 'i1'));
    expect(tx.need.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { analyticalStatus: 'open_gap' },
    });
    tx.need.update.mockClear();
    tx.needInitiative.count.mockResolvedValue(2);
    await asActor(() => svc.unlinkNeed('n1', 'i1'));
    expect(tx.need.update).not.toHaveBeenCalled();
    tx.needInitiative.count.mockResolvedValue(0);
    tx.need.findUnique.mockResolvedValue({
      id: 'n1',
      title: 'A need',
      analyticalStatus: 'observed',
    });
    tx.initiative.findUnique.mockResolvedValue(null);
    await asActor(() => svc.unlinkNeed('n1', 'gone'));
    expect(audit.record.mock.calls.at(-1)![0].changes[0].before).toBe('gone');
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.unlinkNeed('x', 'i1'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
  });

  it('sets a manual status, with an optional note, and does nothing when it is already set', async () => {
    const { svc, tx, audit } = setup();
    await asActor(() => svc.setAnalyticalStatus('n1', 'under_analysis', '  looking  '));
    expect(tx.needAnalyticalStatusEvent.create.mock.calls[0]![0].data.note).toBe('looking');
    await asActor(() => svc.setAnalyticalStatus('n1', 'documented_in_study'));
    expect(tx.needAnalyticalStatusEvent.create.mock.calls[1]![0].data.note).toBeNull();
    tx.need.update.mockClear();
    await asActor(() => svc.setAnalyticalStatus('n1', 'observed'));
    expect(tx.need.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(3);
  });

  it('refuses automatic statuses and unknown needs', async () => {
    const { svc, tx } = setup();
    await expect(
      asActor(() => svc.setAnalyticalStatus('n1', 'linked_to_initiative')),
    ).rejects.toMatchObject({ response: { error: { code: 'STATUS_NOT_MANUALLY_SETTABLE' } } });
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => svc.setAnalyticalStatus('x', 'observed'))).rejects.toMatchObject({
      response: { error: { code: 'NEED_NOT_FOUND' } },
    });
  });

  it('lists the status history of a need', async () => {
    const { svc, tx } = setup();
    tx.needAnalyticalStatusEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        fromStatus: 'observed',
        toStatus: 'under_analysis',
        changedBy: 'u1',
        changedAt: new Date('2026-02-01T00:00:00Z'),
        note: null,
      },
    ]);
    expect(await asActor(() => svc.listAnalyticalStatusHistory('n1'))).toEqual([
      expect.objectContaining({ changedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
  });
});
