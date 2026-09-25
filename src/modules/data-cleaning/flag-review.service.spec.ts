import { describe, expect, it, vi } from 'vitest';
import { orgContext, type OrgStore } from '../../tenancy/org-context';

const phone = vi.hoisted(() => ({
  result: { value: '+966501234567', changed: true } as { value: string | null; changed: boolean },
}));
vi.mock('./normalizers', () => ({ normalizePhone: vi.fn(() => phone.result) }));

import { FlagReviewService } from './flag-review.service';

const run = <T>(store: Partial<OrgStore>, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', ...store } as OrgStore, fn);
const asOrg = <T>(fn: () => Promise<T>) => run({ role: 'ngo_admin' }, fn);

const flag = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  orgId: 'org-1',
  source: 'rules',
  entityType: 'need',
  entityId: 'n1',
  rowNumber: null,
  field: 'title',
  ruleCode: 'TEXT_TRIM',
  severity: 'low',
  originalValue: ' x ',
  proposedValue: 'x',
  confidence: null,
  detail: null,
  status: 'pending',
  note: null,
  reviewedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function setup() {
  const cleaningFlagFindUnique = vi.fn().mockResolvedValue(flag());
  const tx = {
    cleaningFlag: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      findUnique: cleaningFlagFindUnique,
      // the stored row after the update is what was found plus what changed
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...((await cleaningFlagFindUnique.mock.results.filter((r) => r.type === 'return').at(-1)
          ?.value) ?? flag()),
        ...data,
      })),
    },
    cleaningRun: {
      findFirst: vi.fn().mockResolvedValue({ startedAt: new Date('2026-02-01T00:00:00Z') }),
    },
    need: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: 'n1',
          title: 'Old',
          statement: 's',
          domain: 'Water',
          subDomain: 'Wells',
          village: ['A', 'B'],
        }),
      update: vi.fn(),
    },
    needDomain: { findFirst: vi.fn().mockResolvedValue({ id: 'nd1' }), update: vi.fn() },
    center: { findUnique: vi.fn().mockResolvedValue({ name: 'Riyadh Centre' }) },
    surveyResponse: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'r1', mobile: '0501234567', answers: { sq1: 'old' } }),
      update: vi.fn(),
    },
  };
  const tenant = {
    runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const context = { load: vi.fn().mockResolvedValue({ settings: { phoneDefaultRegion: 'SA' } }) };
  const scoring = { scoreResponse: vi.fn().mockResolvedValue(undefined) };
  return {
    tx,
    audit,
    scoring,
    svc: new FlagReviewService(tenant as never, audit as never, context as never, scoring as never),
  };
}

describe('FlagReviewService.list and summary', () => {
  it('lists pending flags with labels for needs and import rows, and whether each can be accepted', async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.findMany.mockResolvedValue([
      flag({ id: 'a', confidence: '0.9' }),
      flag({ id: 'b', entityType: 'import_row', entityId: null, rowNumber: 4, proposedValue: 'x' }),
      flag({ id: 'c', entityType: 'import_row', entityId: null, rowNumber: null }),
      flag({
        id: 'd',
        entityType: 'survey_response',
        entityId: 'r1',
        field: 'mobile',
        proposedValue: null,
        detail: { redacted: true },
      }),
      flag({
        id: 'e',
        entityType: 'survey_response',
        entityId: 'r1',
        field: 'answers[q]',
        proposedValue: null,
        detail: 'x',
      }),
      flag({ id: 'f', entityType: 'need', entityId: 'unknown' }),
    ]);
    tx.cleaningFlag.count.mockResolvedValue(6);
    tx.need.findMany.mockResolvedValue([{ id: 'n1', internalRefSeq: 12, title: 'Wells' }]);
    const result = await asOrg(() => svc.list({}));
    expect(result.total).toBe(6);
    const by = Object.fromEntries(result.items.map((i) => [i.id, i]));
    expect(by.a).toMatchObject({
      entityLabel: 'NEED-000012 · Wells',
      confidence: 0.9,
      acceptable: true,
    });
    expect(by.b).toMatchObject({ entityLabel: 'Row 4', acceptable: false });
    expect(by.c!.entityLabel).toBe('Row ?');
    expect(by.d!.acceptable).toBe(true);
    expect(by.e!.acceptable).toBe(false);
    expect(by.f!.entityLabel).toBeNull();
  });

  it('applies every filter and paging, and reads across organizations for a supervisor', async () => {
    const { svc, tx } = setup();
    await run({ role: 'system_admin' }, () =>
      svc.list({
        status: 'accepted',
        source: 'survey_response',
        severity: 'missing',
        ruleCode: 'R',
        studyId: 's1',
        page: 3,
        pageSize: 5,
      }),
    );
    expect(tx.cleaningFlag.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        status: 'accepted',
        source: 'survey_response',
        severity: 'missing',
        ruleCode: 'R',
        studyId: 's1',
      },
      skip: 10,
      take: 5,
    });
    expect(tx.need.findMany).not.toHaveBeenCalled();
    await asOrg(() => svc.list({}));
    expect(tx.cleaningFlag.findMany.mock.calls[1]![0]).toMatchObject({
      where: { status: 'pending' },
      skip: 0,
      take: 25,
    });
  });

  it('summarises flags by source and rule, most common first, with the last run time', async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.groupBy
      .mockResolvedValueOnce([{ source: 'rules', status: 'pending', _count: { _all: 2 } }])
      .mockResolvedValueOnce([
        { ruleCode: 'A', severity: 'low', source: 'rules', _count: { _all: 1 } },
        { ruleCode: 'B', severity: 'high', source: 'rules', _count: { _all: 5 } },
      ]);
    const summary = await asOrg(() => svc.summary());
    expect(summary.bySource).toEqual([{ source: 'rules', status: 'pending', count: 2 }]);
    expect(summary.byRule.map((r) => r.ruleCode)).toEqual(['B', 'A']);
    expect(summary.lastRunAt).toEqual(new Date('2026-02-01T00:00:00Z'));
    tx.cleaningRun.findFirst.mockResolvedValue(null);
    expect((await run({ role: 'center_supervisor' }, () => svc.summary())).lastRunAt).toBeNull();
  });
});

describe('FlagReviewService.review', () => {
  it('accepts a proposal on a need field, keeps the first domain row in step, and audits both steps', async () => {
    const { svc, tx, audit } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({ field: 'domain', proposedValue: 'Health' }),
    );
    const result = await asOrg(() => svc.review('f1', 'accept', ' fine '));
    expect(tx.need.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { domain: 'Health' },
    });
    expect(tx.needDomain.update).toHaveBeenCalledWith({
      where: { id: 'nd1' },
      data: { domain: 'Health' },
    });
    expect(result.status).toBe('accepted');
    expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual([
      'review_cleaning_flag',
      'apply_standardization',
    ]);
    expect(tx.cleaningFlag.update.mock.calls[0]![0].data.note).toBe('fine');
  });

  it('updates a plain text field without touching the domain rows, or when there is no domain row', async () => {
    const { svc, tx } = setup();
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(tx.needDomain.findFirst).not.toHaveBeenCalled();
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({ field: 'subDomain', proposedValue: 'Taps' }),
    );
    tx.needDomain.findFirst.mockResolvedValue(null);
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(tx.needDomain.update).not.toHaveBeenCalled();
  });

  it('replaces a village with the matched centre name', async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({ field: 'village[1]', proposedValue: 'C-01' }),
    );
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(tx.need.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { village: ['A', 'Riyadh Centre'] },
    });
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({ field: 'village[5]', proposedValue: 'C-01' }),
    );
    await asOrg(() => svc.review('f1', 'accept', undefined));
    tx.center.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.review('f1', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'REFERENCE_NOT_FOUND' } },
    });
  });

  it('rejects a proposal without changing the record, but only with a note', async () => {
    const { svc, tx } = setup();
    await expect(asOrg(() => svc.review('f1', 'reject', '  '))).rejects.toMatchObject({
      response: { error: { code: 'NOTE_REQUIRED' } },
    });
    await expect(asOrg(() => svc.review('f1', 'reject', undefined))).rejects.toMatchObject({
      response: { error: { code: 'NOTE_REQUIRED' } },
    });
    const result = await asOrg(() => svc.review('f1', 'reject', 'Correct as is'));
    expect(result.status).toBe('rejected');
    expect(tx.need.update).not.toHaveBeenCalled();
  });

  it('refuses unknown or already decided flags', async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.review('x', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'FLAG_NOT_FOUND' } },
    });
    tx.cleaningFlag.findUnique.mockResolvedValueOnce(flag({ status: 'accepted' }));
    await expect(asOrg(() => svc.review('f1', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'FLAG_ALREADY_DECIDED' } },
    });
  });

  it('refuses proposals it cannot apply', async () => {
    const { svc, tx } = setup();
    const attempt = async (over: Record<string, unknown>) => {
      tx.cleaningFlag.findUnique.mockResolvedValueOnce(flag(over));
      return asOrg(() => svc.review('f1', 'accept', undefined)).catch((e) => e.getResponse().error);
    };
    expect((await attempt({ entityType: 'import_row' })).code).toBe('NOTHING_TO_APPLY');
    expect((await attempt({ entityId: null })).message).toContain('no record');
    expect((await attempt({ entityType: 'other', entityId: 'x' })).message).toContain(
      'Unsupported',
    );
    expect((await attempt({ field: 'status', proposedValue: 'x' })).message).toContain(
      'Cannot correct',
    );
    tx.need.findUnique.mockResolvedValueOnce(null);
    expect((await attempt({})).code).toBe('NEED_NOT_FOUND');
  });

  it('standardises a mobile number and re-reads it from the record', async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({
        entityType: 'survey_response',
        entityId: 'r1',
        field: 'mobile',
        proposedValue: null,
        detail: { redacted: true },
      }),
    );
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(tx.surveyResponse.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { mobile: '+966501234567' },
    });
    phone.result = { value: null, changed: false };
    await expect(asOrg(() => svc.review('f1', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'NOTHING_TO_APPLY' } },
    });
    phone.result = { value: '+966501234567', changed: true };
    tx.surveyResponse.findUnique.mockResolvedValueOnce(null);
    await expect(asOrg(() => svc.review('f1', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'RESPONSE_NOT_FOUND' } },
    });
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({ entityType: 'survey_response', entityId: 'r1', field: 'email', proposedValue: 'x' }),
    );
    await expect(asOrg(() => svc.review('f1', 'accept', undefined))).rejects.toMatchObject({
      response: { error: { code: 'NOTHING_TO_APPLY' } },
    });
  });

  it('writes a corrected answer back and rescoring the response, or notes that rescoring failed', async () => {
    const { svc, tx, scoring, audit } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValue(
      flag({
        entityType: 'survey_response',
        entityId: 'r1',
        field: 'answers[sq1]',
        proposedValue: 'new',
        detail: { surveyQuestionId: 'sq1' },
      }),
    );
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(tx.surveyResponse.update.mock.calls[0]![0].data.answers).toEqual({ sq1: 'new' });
    expect(scoring.scoreResponse).toHaveBeenCalledWith('r1', 'org-1');
    expect(audit.record.mock.calls[1]![0].changes[1].after).toContain('recalculated');

    scoring.scoreResponse.mockRejectedValueOnce(new Error('boom'));
    await asOrg(() => svc.review('f1', 'accept', undefined));
    expect(audit.record.mock.calls[3]![0].changes[1].after).toContain('re-scoring failed');
  });

  it('refuses an answer correction that cannot be written back', async () => {
    const { svc, tx } = setup();
    const attempt = async (over: Record<string, unknown>) => {
      tx.cleaningFlag.findUnique.mockResolvedValueOnce(
        flag({
          entityType: 'survey_response',
          entityId: 'r1',
          field: 'answers[sq1]',
          proposedValue: 'new',
          detail: { surveyQuestionId: 'sq1' },
          ...over,
        }),
      );
      return asOrg(() => svc.review('f1', 'accept', undefined)).catch((e) => e.getResponse().error);
    };
    expect((await attempt({ detail: {} })).message).toContain('written back');
    expect((await attempt({ detail: null })).code).toBe('NOTHING_TO_APPLY');
    tx.surveyResponse.findUnique
      .mockResolvedValueOnce({ id: 'r1', mobile: null, answers: {} })
      .mockResolvedValueOnce({ answers: null });
    expect((await attempt({})).message).toContain('no longer on this response');
    tx.surveyResponse.findUnique
      .mockResolvedValueOnce({ id: 'r1', mobile: null, answers: {} })
      .mockResolvedValueOnce(null);
    expect((await attempt({})).code).toBe('RESPONSE_NOT_FOUND');
    tx.surveyResponse.findUnique
      .mockResolvedValueOnce({ id: 'r1', mobile: null, answers: {} })
      .mockResolvedValueOnce({ answers: { sq1: null } });
    await attempt({});
    expect(tx.surveyResponse.update).toHaveBeenCalled();
  });

  it("finds the flag's own organization for a supervisor", async () => {
    const { svc, tx } = setup();
    tx.cleaningFlag.findUnique.mockResolvedValueOnce({ orgId: 'org-9' }).mockResolvedValue(flag());
    await run({ role: 'system_admin' }, () => svc.review('f1', 'reject', 'no'));
    tx.cleaningFlag.findUnique.mockResolvedValueOnce(null).mockResolvedValue(flag());
    await run({ role: 'system_admin' }, () => svc.review('f1', 'reject', 'no'));
  });
});

describe('FlagReviewService.bulkAccept', () => {
  it('accepts the safe pending corrections of one rule, skipping those that no longer apply, and audits the batch', async () => {
    const { svc, tx, audit } = setup();
    tx.cleaningFlag.findMany.mockResolvedValue([
      flag({ id: 'a' }),
      flag({ id: 'b', entityType: 'import_row' }),
      flag({ id: 'c' }),
    ]);
    const result = await asOrg(() => svc.bulkAccept('TEXT_TRIM', 'rules', ' bulk '));
    expect(result).toEqual({ accepted: 2, skipped: 1 });
    expect(tx.cleaningFlag.findMany.mock.calls[0]![0].where).toMatchObject({
      ruleCode: 'TEXT_TRIM',
      source: 'rules',
      confidence: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityLabel: 'Bulk-accepted 2 TEXT_TRIM correction(s)' }),
    );
  });

  it('does not audit when nothing was accepted', async () => {
    const { svc, audit } = setup();
    expect(await asOrg(() => svc.bulkAccept('R', undefined, undefined))).toEqual({
      accepted: 0,
      skipped: 0,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
