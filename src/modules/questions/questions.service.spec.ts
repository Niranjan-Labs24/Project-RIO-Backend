import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma';
import { orgContext } from '../../tenancy/org-context';
import { QuestionsService } from './questions.service';

const asActor = <T>(fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'user-1' }, fn);

function question(over: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    questionId: 'Q-001',
    domain: 'Health',
    subDomain: 'Clinics',
    indicator: 'Access',
    kpi: 'Distance',
    priorityWeight: { toNumber: () => 2.5 },
    questionText: 'How far is the clinic?',
    questionTextAr: null,
    indicatorAr: null,
    kpiAr: null,
    answerOptionsAr: '["a"]',
    answerType: 'select',
    answerOptions: '["x","y"]',
    requiredOptional: 'required',
    usedInMvp: true,
    reportMapping: null,
    answerTypeRaw: null,
    measurementMode: 'SINGLE_SELECT',
    rosterScope: null,
    rosterLoop: null,
    isCompound: false,
    isScoreable: true,
    analyticalCategory: null,
    targetRespondent: 'Head of household',
    feedsKpiAnchor: null,
    isActive: true,
    deactivatedAt: null,
    version: 1,
    isCurrentVersion: true,
    approvalStatus: 'approved',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    reviewedAt: new Date('2026-01-02T00:00:00Z'),
    rejectionReason: null,
    previousVersionId: null,
    submittedBy: null,
    reviewedBy: null,
    conditionalRule: null,
    isFielded: true,
    ...over,
  };
}

function setup() {
  const tx = {
    methodologyVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'mv-1' }) },
    question: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
  const tenant = {
    runAsSupervisor: async (fn: (t: unknown) => unknown) => fn(tx),
    runAsSupervisorWrite: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  return { tx, audit, svc: new QuestionsService(tenant as never, audit as never) };
}

describe('QuestionsService reads', () => {
  it('resolves the published methodology version, or the one asked for', async () => {
    const { svc, tx } = setup();
    await svc.getDomainOptions();
    expect(tx.methodologyVersion.findFirst.mock.calls[0]![0].where).toEqual({
      status: 'PUBLISHED',
    });
    await svc.getDomainOptions('v5.0');
    expect(tx.methodologyVersion.findFirst.mock.calls[1]![0].where).toEqual({ version: 'v5.0' });
  });

  it('explains a missing version, with and without a label', async () => {
    const { svc, tx } = setup();
    tx.methodologyVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getDomainOptions()).rejects.toMatchObject({
      response: {
        error: {
          code: 'METHODOLOGY_VERSION_NOT_FOUND',
          message: expect.stringContaining('No published'),
        },
      },
    });
    await expect(svc.getKpiOptions('v9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists KPI and target respondent options, dropping empty values', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValueOnce([{ kpi: 'A' }, { kpi: null }, { kpi: '' }]);
    expect(await svc.getKpiOptions()).toEqual(['A']);
    tx.question.findMany.mockResolvedValueOnce([
      { targetRespondent: 'Women' },
      { targetRespondent: null },
    ]);
    expect(await svc.getTargetRespondentOptions()).toEqual(['Women']);
  });

  it('filters questions by domain pairs and maps rows, parsing JSON strings', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([question()]);
    const rows = await svc.getQuestions([{ domain: 'Health', subDomain: 'Clinics' }]);
    expect(tx.question.findMany.mock.calls[0]![0].where.OR).toEqual([
      { domain: 'Health', subDomain: 'Clinics' },
    ]);
    expect(rows[0]).toMatchObject({
      priorityWeight: 2.5,
      answerOptions: ['x', 'y'],
      answerOptionsAr: ['a'],
      submittedAt: '2026-01-01T00:00:00.000Z',
      deactivatedAt: null,
    });
    await svc.getQuestions([]);
    expect(tx.question.findMany.mock.calls[1]![0].where.OR).toBeUndefined();
  });

  it('maps a row with no weight, real JSON and no dates', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([
      question({
        priorityWeight: null,
        answerOptions: ['x'],
        answerOptionsAr: null,
        submittedAt: null,
        reviewedAt: null,
        deactivatedAt: new Date('2026-02-01T00:00:00Z'),
      }),
    ]);
    const [row] = await svc.getQuestionsForManagement([]);
    expect(row).toMatchObject({
      priorityWeight: null,
      answerOptions: ['x'],
      submittedAt: null,
      deactivatedAt: '2026-02-01T00:00:00.000Z',
    });
    await svc.getQuestionsForManagement([{ domain: 'D', subDomain: 'S' }]);
  });

  it('lists the changes waiting for approval', async () => {
    const { svc, tx } = setup();
    tx.question.findMany.mockResolvedValue([question({ approvalStatus: 'pending_approval' })]);
    expect(await svc.listPendingApprovals()).toHaveLength(1);
  });
});

describe('QuestionsService create', () => {
  const input = {
    questionId: 'Q-9',
    domain: 'Health',
    subDomain: 'Clinics',
    questionText: 'Text',
    answerType: 'select' as const,
    answerOptions: ['a', 'b'],
    requiredOptional: 'required' as const,
  };

  it('creates a pending question and records the audit trail', async () => {
    const { svc, tx, audit } = setup();
    tx.question.create.mockResolvedValue(
      question({ id: 'new', questionId: 'Q-9', answerType: 'select' }),
    );
    const row = await asActor(() => svc.create(input));
    expect(row.questionId).toBe('Q-9');
    expect(tx.question.create.mock.calls[0]![0].data).toMatchObject({
      approvalStatus: 'pending_approval',
      measurementMode: 'SINGLE_SELECT',
      isScoreable: true,
      submittedBy: 'user-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'create', metadata: { awaitingApproval: true } }),
    );
  });

  it('maps every answer type to its measurement mode, and open-ended is not scoreable', async () => {
    const { svc, tx } = setup();
    tx.question.create.mockResolvedValue(question());
    await asActor(() =>
      svc.create({ ...input, answerType: 'open_ended', answerOptions: undefined }),
    );
    expect(tx.question.create.mock.calls[0]![0].data).toMatchObject({
      measurementMode: 'OPEN_TEXT',
      isScoreable: false,
    });
    expect(tx.question.create.mock.calls[0]![0].data.answerOptions).toBe(Prisma.JsonNull);
    await asActor(() => svc.create({ ...input, answerType: 'numeric', answerOptions: [] }));
    expect(tx.question.create.mock.calls[1]![0].data.measurementMode).toBe('NUMERIC');
  });

  it('requires options for choice-type questions', async () => {
    const { svc } = setup();
    for (const answerType of ['select', 'multiselect', 'checklist'] as const) {
      await expect(
        asActor(() => svc.create({ ...input, answerType, answerOptions: [] })),
      ).rejects.toMatchObject({
        response: { error: { code: 'ANSWER_OPTIONS_REQUIRED' } },
      });
    }
  });

  it('maps a duplicate question id to a clear conflict and rethrows anything else', async () => {
    const { svc, tx } = setup();
    tx.question.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(asActor(() => svc.create(input))).rejects.toMatchObject({
      response: { error: { code: 'QUESTION_ID_TAKEN' } },
    });
    tx.question.create.mockRejectedValueOnce(new Error('db down'));
    await expect(asActor(() => svc.create(input))).rejects.toThrow('db down');
  });
});

describe('QuestionsService changes', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.tx.question.findUnique.mockResolvedValue(question());
    ctx.tx.question.create.mockResolvedValue(
      question({ id: 'pending', approvalStatus: 'pending_approval' }),
    );
  });

  it('turns an edit into a pending new version with an audit trail', async () => {
    const pending = await asActor(() => ctx.svc.update('q1', { questionText: 'New text' }));
    expect(pending.id).toBe('pending');
    const data = ctx.tx.question.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      questionText: 'New text',
      version: 2,
      isCurrentVersion: false,
      previousVersionId: 'q1',
    });
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { supersedes: 'q1', awaitingApproval: true } }),
    );
  });

  it('keeps JSON columns as JsonNull when empty', async () => {
    ctx.tx.question.findUnique.mockResolvedValue(
      question({ answerOptions: null, answerOptionsAr: null, conditionalRule: null }),
    );
    await asActor(() => ctx.svc.update('q1', { kpi: null }));
    const data = ctx.tx.question.create.mock.calls[0]![0].data;
    expect(data.answerOptions).toBe(Prisma.JsonNull);
    expect(data.conditionalRule).toBe(Prisma.JsonNull);
  });

  it('deactivates and reactivates through the same approval path', async () => {
    await asActor(() => ctx.svc.deactivate('q1'));
    expect(ctx.tx.question.create.mock.calls[0]![0].data).toMatchObject({
      isActive: false,
      deactivatedBy: 'user-1',
    });
    await asActor(() => ctx.svc.reactivate('q1'));
    expect(ctx.tx.question.create.mock.calls[1]![0].data).toMatchObject({
      isActive: true,
      deactivatedAt: null,
    });
  });

  it('refuses to change an unknown, non-current or already pending question', async () => {
    ctx.tx.question.findUnique.mockResolvedValueOnce(null);
    await expect(asActor(() => ctx.svc.update('x', {}))).rejects.toMatchObject({
      response: { error: { code: 'QUESTION_NOT_FOUND' } },
    });
    ctx.tx.question.findUnique.mockResolvedValueOnce(question({ isCurrentVersion: false }));
    await expect(asActor(() => ctx.svc.update('q1', {}))).rejects.toBeInstanceOf(ConflictException);
    ctx.tx.question.findUnique.mockResolvedValueOnce(
      question({ approvalStatus: 'pending_approval' }),
    );
    await expect(asActor(() => ctx.svc.update('q1', {}))).rejects.toMatchObject({
      response: { error: { code: 'QUESTION_HAS_PENDING_CHANGE' } },
    });
  });

  it('approves a pending change, retiring the previous version and auditing what changed', async () => {
    ctx.tx.question.findUnique
      .mockResolvedValueOnce(
        question({
          id: 'p1',
          approvalStatus: 'pending_approval',
          previousVersionId: 'q1',
          questionText: 'New',
        }),
      )
      .mockResolvedValueOnce(question({ questionText: 'Old' }));
    ctx.tx.question.update.mockResolvedValue(question({ id: 'p1', questionText: 'New' }));
    await asActor(() => ctx.svc.approve('p1'));
    expect(ctx.tx.question.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: { isCurrentVersion: false },
    });
    const audit = ctx.audit.record.mock.calls[0]![0];
    expect(audit.action).toBe('approve');
    expect(audit.changes.length).toBeGreaterThan(0);
  });

  it('approves a brand-new question that has no previous version', async () => {
    ctx.tx.question.findUnique.mockResolvedValueOnce(
      question({ id: 'p1', approvalStatus: 'pending_approval', previousVersionId: null }),
    );
    ctx.tx.question.update.mockResolvedValue(question({ id: 'p1' }));
    await asActor(() => ctx.svc.approve('p1'));
    expect(ctx.audit.record.mock.calls[0]![0].changes[0].after).toBe('Approved');
  });

  it('rejects approving or rejecting something that is not pending', async () => {
    ctx.tx.question.findUnique.mockResolvedValue(question());
    await expect(asActor(() => ctx.svc.approve('q1'))).rejects.toMatchObject({
      response: { error: { code: 'QUESTION_NOT_PENDING' } },
    });
    await expect(asActor(() => ctx.svc.reject('q1', 'no'))).rejects.toMatchObject({
      response: { error: { code: 'QUESTION_NOT_PENDING' } },
    });
  });

  it("rejects a pending change with the reviewer's reason", async () => {
    ctx.tx.question.findUnique.mockResolvedValue(question({ approvalStatus: 'pending_approval' }));
    ctx.tx.question.update.mockResolvedValue(question({ approvalStatus: 'rejected' }));
    await asActor(() => ctx.svc.reject('q1', 'Not clear'));
    expect(ctx.tx.question.update.mock.calls[0]![0].data).toMatchObject({
      approvalStatus: 'rejected',
      rejectionReason: 'Not clear',
    });
    expect(ctx.audit.record.mock.calls[0]![0].changes[0].after).toBe('Not clear');
  });
});
