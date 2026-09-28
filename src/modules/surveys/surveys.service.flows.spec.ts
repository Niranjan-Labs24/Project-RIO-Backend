import { describe, expect, it, vi } from 'vitest';
import { SurveysService } from './surveys.service';
import { orgContext } from '../../tenancy/org-context';

type Fn = ReturnType<typeof vi.fn>;
// Every model/method is created on demand, so indexing can never be undefined.
type FakeTx = any;

/** A tx whose every `tx.model.method` is a cached vi.fn(), created on first use. */
function makeTx(): FakeTx {
  const models = new Map<string, Record<string, Fn>>();
  return new Proxy({} as FakeTx, {
    get(_t, model: string) {
      if (!models.has(model)) {
        const methods = new Map<string, Fn>();
        models.set(
          model,
          new Proxy({} as Record<string, Fn>, {
            get(_m, method: string) {
              if (!methods.has(method)) methods.set(method, vi.fn());
              return methods.get(method)!;
            },
          }),
        );
      }
      return models.get(model)!;
    },
  });
}

function setup() {
  const tx = makeTx();
  const call = async (fn: (t: unknown) => unknown) => fn(tx);
  const tenant = {
    runRead: call,
    runInOrgContext: call,
    runAsSupervisor: call,
    runAsOrg: (_o: string, fn: (t: unknown) => unknown) => call(fn),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const ai = { run: vi.fn(), resolveModelName: vi.fn().mockReturnValue('model-x') };
  const methodology = { listVersionOptions: vi.fn().mockResolvedValue([{ version: 'v1' }]) };
  const svc = new SurveysService(
    tenant as never,
    audit as never,
    ai as never,
    methodology as never,
  );
  return { tx, audit, ai, methodology, svc };
}

const as = <T>(role: string | undefined, fn: () => Promise<T>) =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', role } as never, fn);

const decimal = (n: number) => ({ toNumber: () => n });
const bankQ = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  questionId: 'Q-1',
  questionText: 'Text',
  questionTextAr: null,
  answerType: 'select',
  answerOptions: '["a","b"]',
  answerOptionsAr: '["x"]',
  domain: 'D',
  subDomain: 'S',
  indicator: 'I',
  kpi: 'K',
  indicatorAr: null,
  kpiAr: null,
  priorityWeight: decimal(0.5),
  ...over,
});
const sq = (over: Record<string, unknown> = {}) => ({
  id: 'sq1',
  order: 1,
  isRequired: true,
  customText: null,
  customAnswerType: null,
  customOptions: null,
  domain: null,
  subDomain: null,
  kpi: null,
  question: bankQ(),
  ...over,
});
const surveyRow = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  needId: 'n1',
  studyId: 'st1',
  orgId: 'org-1',
  title: 'T',
  status: 'DRAFT',
  methodologyVersion: 'v1',
  version: 1,
  previousVersionId: null,
  targetGroup: null,
  expectedSampleSize: null,
  selectionApproach: null,
  geographicCoverage: null,
  submittedAt: null,
  approverComments: null,
  rejectionReasonCode: null,
  approvedAt: null,
  approvedBy: null,
  rejectedAt: null,
  rejectedBy: null,
  publishedAt: null,
  publishedBy: null,
  surveyQuestions: [sq()],
  ...over,
});
const code = (c: string) =>
  expect.objectContaining({ response: { error: expect.objectContaining({ code: c }) } });

describe('SurveysService read models', () => {
  it('maps bank and custom questions, parsing JSON strings and hiding weight from citizens', async () => {
    const { svc, tx } = setup();
    tx.survey.findFirst.mockResolvedValueOnce(
      surveyRow({
        surveyQuestions: [
          sq(),
          sq({ id: 'sq2', question: null, customText: 'Why?', customOptions: '["y"]', kpi: 'k' }),
          sq({
            id: 'sq3',
            question: null,
            customText: 'x',
            customOptions: undefined,
            customAnswerType: 'numeric',
          }),
          sq({ id: 'sq4', question: bankQ({ answerOptions: ['o'], answerOptionsAr: null }) }),
        ],
      }),
    );
    const out = (await svc.getPublishedSurveyByNeedId('n1'))!;
    expect(out.questions[0]).toMatchObject({
      answerOptions: ['a', 'b'],
      answerOptionsAr: ['x'],
      priorityWeight: undefined,
      isCustom: false,
    });
    expect(out.questions[1]).toMatchObject({
      isCustom: true,
      answerOptions: ['y'],
      answerType: 'long_text',
      questionText: 'Why?',
    });
    expect(out.questions[2]).toMatchObject({ answerOptions: null, answerType: 'numeric' });
    tx.survey.findFirst.mockResolvedValueOnce(null);
    expect(await svc.getPublishedSurveyByNeedId('n1')).toBeNull();
  });

  it('returns the latest / live survey detail with reviewer names, or null', async () => {
    const { svc, tx } = setup();
    tx.user.findMany.mockResolvedValue([{ id: 'a', name: 'Amy' }]);
    const at = new Date('2026-01-01T00:00:00Z');
    tx.survey.findFirst.mockResolvedValue(
      surveyRow({
        approvedBy: 'a',
        approvedAt: at,
        rejectedBy: 'zz',
        rejectedAt: at,
        publishedBy: 'a',
        publishedAt: at,
        submittedAt: at,
        surveyQuestions: [sq({ question: bankQ({ priorityWeight: undefined }) })],
      }),
    );
    const detail = (await svc.getSurveyByNeedId('n1'))!;
    expect(detail).toMatchObject({
      approvedByName: 'Amy',
      rejectedByName: null,
      publishedByName: 'Amy',
      submittedAt: at.toISOString(),
    });
    expect(detail.questions[0]!.priorityWeight).toBeNull();
    expect((await svc.getPublishedSurveyForOrgByNeedId('n1'))!.id).toBe('s1');
    tx.survey.findFirst.mockResolvedValue(surveyRow());
    expect((await svc.getSurveyByNeedId('n1'))!.approvedByName).toBeNull();
    tx.survey.findFirst.mockResolvedValue(null);
    expect(await svc.getSurveyByNeedId('n1')).toBeNull();
    expect(await svc.getPublishedSurveyForOrgByNeedId('n1')).toBeNull();
  });

  it('counts the responses that belong to each survey version', async () => {
    const { svc, tx } = setup();
    tx.survey.findMany.mockResolvedValue([
      { id: 'v1', version: 1, status: 'SUPERSEDED', title: 'T', surveyQuestions: [{ id: 'a' }] },
      { id: 'v2', version: 2, status: 'DRAFT', title: 'T', surveyQuestions: [{ id: 'b' }] },
    ]);
    tx.surveyResponse.findMany.mockResolvedValue([
      { answers: { a: '1' } },
      { answers: null },
      { answers: { b: '1' } },
      { answers: { a: '1', b: '1' } },
    ]);
    const out = await svc.listSurveyVersionsByNeedId('n1');
    expect(out.map((v) => v.responseCount)).toEqual([2, 2]);
  });

  it('lists reusable custom questions, deduping by text and filtering by domain when given', async () => {
    const { svc, tx } = setup();
    const row = (id: string, text: string | null, extra: Record<string, unknown> = {}) => ({
      id,
      customText: text,
      customAnswerType: null,
      customOptions: null,
      domain: 'D',
      subDomain: 'S',
      kpi: null,
      survey: { title: 'S1' },
      ...extra,
    });
    tx.surveyQuestion.findMany.mockResolvedValue([
      row('1', 'Hi '),
      row('2', 'hi'),
      row('3', null),
      row('4', 'Opts', { customOptions: '["a"]', customAnswerType: 'select' }),
    ]);
    const out = await svc.listReusableCustomQuestions('D', 'S');
    expect(out.map((o) => o.id)).toEqual(['1', '4']);
    expect(out[1]).toMatchObject({ answerOptions: ['a'], answerType: 'select' });
    expect(tx.surveyQuestion.findMany.mock.calls[0]![0].where).toEqual({
      customText: { not: null },
      domain: 'D',
      subDomain: 'S',
    });
    await svc.listReusableCustomQuestions();
    expect(tx.surveyQuestion.findMany.mock.calls[1]![0].where).toEqual({
      customText: { not: null },
    });
  });
});

describe('SurveysService.createEmptySurvey', () => {
  const need = (over: Record<string, unknown> = {}) => ({
    id: 'n1',
    studyId: 'st1',
    title: 'N',
    domain: 'D',
    subDomain: 'S',
    status: 'reviewer_approved',
    ...over,
  });

  it('creates a draft survey, moves the need on, and audits', async () => {
    const { svc, tx, audit } = setup();
    tx.need.findUnique.mockResolvedValue(need());
    tx.survey.findFirst.mockResolvedValueOnce(null).mockResolvedValue(surveyRow());
    tx.survey.create.mockResolvedValue({ id: 's1', title: 'N', status: 'DRAFT' });
    await as(undefined, () => svc.createEmptySurvey('n1'));
    expect(tx.need.update.mock.calls[0]![0].data).toEqual({ status: 'survey_created' });
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('is idempotent when a survey already exists', async () => {
    const { svc, tx, audit } = setup();
    tx.need.findUnique.mockResolvedValue(need());
    tx.survey.findFirst.mockResolvedValue(surveyRow());
    await as(undefined, () => svc.createEmptySurvey('n1'));
    expect(tx.survey.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses an unknown need, a need without a domain, or an unapproved classification', async () => {
    const { svc, tx } = setup();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.createEmptySurvey('n1'))).rejects.toThrow(
      code('NEED_NOT_FOUND'),
    );
    tx.need.findUnique.mockResolvedValueOnce(need({ domain: null }));
    await expect(as(undefined, () => svc.createEmptySurvey('n1'))).rejects.toThrow(
      code('NO_APPROVED_DOMAIN'),
    );
    tx.need.findUnique.mockResolvedValueOnce(need({ status: 'pending_ai_classification' }));
    await expect(as(undefined, () => svc.createEmptySurvey('n1'))).rejects.toThrow(
      code('AI_CLASSIFICATION_NOT_APPROVED'),
    );
  });
});

describe('SurveysService.recommendQuestions', () => {
  it('routes to the right domain source', async () => {
    const { svc, tx } = setup();
    const gen = vi.spyOn(svc, 'generateSuggestedQuestions').mockResolvedValue('ok' as never);
    tx.need.findUnique.mockResolvedValue({
      id: 'n1',
      allDomainsSelected: false,
      domain: 'D',
      subDomain: 'S',
    });
    tx.needDomain.findMany.mockResolvedValueOnce([{ domain: 'A', subDomain: 'B' }]);
    await svc.recommendQuestions('n1');
    expect(gen).toHaveBeenLastCalledWith('n1', [{ domain: 'A', subDomain: 'B' }]);
    tx.needDomain.findMany.mockResolvedValueOnce([]);
    tx.need.findUnique.mockResolvedValueOnce({ id: 'n1', allDomainsSelected: true });
    await svc.recommendQuestions('n1');
    expect(gen).toHaveBeenLastCalledWith('n1', []);
    tx.needDomain.findMany.mockResolvedValueOnce([]);
    await svc.recommendQuestions('n1');
    expect(gen).toHaveBeenLastCalledWith('n1', [{ domain: 'D', subDomain: 'S' }]);
    tx.needDomain.findMany.mockResolvedValueOnce([]);
    tx.need.findUnique.mockResolvedValueOnce({
      id: 'n1',
      allDomainsSelected: false,
      domain: null,
      aiSuggestedDomain: 'AD',
      subDomain: null,
      aiSuggestedSubDomain: 'AS',
    });
    await svc.recommendQuestions('n1');
    expect(gen).toHaveBeenLastCalledWith('n1', [{ domain: 'AD', subDomain: 'AS' }]);
    tx.needDomain.findMany.mockResolvedValueOnce([]);
    tx.need.findUnique.mockResolvedValueOnce({
      id: 'n1',
      allDomainsSelected: false,
      domain: null,
      subDomain: null,
    });
    await expect(svc.recommendQuestions('n1')).rejects.toThrow(code('NO_APPROVED_DOMAIN'));
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(svc.recommendQuestions('n1')).rejects.toThrow(code('NEED_NOT_FOUND'));
  });
});

describe('SurveysService.generateSuggestedQuestions', () => {
  const need = {
    id: 'n1',
    studyId: 'st1',
    title: 'N',
    statement: 'stmt',
    study: { studyType: 'x', targetSector: 'y' },
  };
  const q = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    questionId: `Q-${id}`,
    questionText: 't',
    answerType: 'select',
    answerOptions: '["a"]',
    indicator: 'I',
    kpi: 'K',
    domain: 'D',
    subDomain: 'S',
    requiredOptional: 'required',
    ...over,
  });
  function ready() {
    const s = setup();
    s.tx.need.findUnique.mockResolvedValue(need);
    s.tx.survey.findFirst.mockResolvedValue(null);
    s.tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv', version: 'v1' });
    s.tx.question.findMany.mockResolvedValue([
      q('1'),
      q('2', { requiredOptional: 'optional', answerOptions: ['b'] }),
    ]);
    s.tx.survey.create.mockResolvedValue({ id: 's1', title: 'N', status: 'DRAFT' });
    return s;
  }

  it('uses the AI recommendation, creating the draft survey and its links', async () => {
    const { svc, tx, ai } = ready();
    ai.run.mockResolvedValue({
      response: { recommendedQuestionIds: ['Q-1'], confidence: 0.8, reason: 'why' },
      raw: { r: 1 },
    });
    tx.survey.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(surveyRow());
    await as(undefined, () =>
      svc.generateSuggestedQuestions('n1', [{ domain: 'D', subDomain: 'S' }]),
    );
    expect(tx.surveyQuestion.createMany.mock.calls[0]![0].data).toHaveLength(1);
    expect(tx.aiSuggestion.create.mock.calls[0]![0].data).toMatchObject({
      confidence: 0.8,
      reason: 'why',
      modelName: 'model-x',
    });
  });

  it('falls back to every eligible question when the AI is down or recommends nothing valid', async () => {
    const { svc, tx, ai } = ready();
    ai.run.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce('str');
    await as(undefined, () => svc.generateSuggestedQuestions('n1', []));
    expect(tx.aiSuggestion.create.mock.calls[0]![0].data.reason).toContain('offline');
    await as(undefined, () => svc.generateSuggestedQuestions('n1', []));
    expect(tx.aiSuggestion.create.mock.calls[1]![0].data.reason).toContain('str');
    ai.run.mockResolvedValueOnce({ response: {}, raw: null });
    await as(undefined, () => svc.generateSuggestedQuestions('n1', []));
    expect(tx.surveyQuestion.createMany.mock.calls[2]![0].data).toHaveLength(2);
  });

  it('updates an existing draft and still works when no question matches', async () => {
    const { svc, tx, ai } = ready();
    tx.question.findMany.mockResolvedValue([]);
    tx.survey.findFirst.mockResolvedValue(surveyRow({ methodologyVersion: null }));
    tx.survey.update.mockResolvedValue({ id: 's1', title: 'N', status: 'DRAFT' });
    await as(undefined, () =>
      svc.generateSuggestedQuestions('n1', [{ domain: 'D', subDomain: 'S' }]),
    );
    expect(ai.run).not.toHaveBeenCalled();
    expect(tx.aiSuggestion.create.mock.calls[0]![0].data.reason).toContain(
      'No Question Bank questions match',
    );
    expect(tx.survey.update).toHaveBeenCalled();
  });

  it('refuses unknown need, published or submitted survey, or missing methodology', async () => {
    const { svc, tx } = ready();
    tx.need.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.generateSuggestedQuestions('n1', []))).rejects.toThrow(
      code('NEED_NOT_FOUND'),
    );
    tx.survey.findFirst.mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED' }));
    await expect(as(undefined, () => svc.generateSuggestedQuestions('n1', []))).rejects.toThrow(
      code('SURVEY_ALREADY_PUBLISHED'),
    );
    tx.survey.findFirst.mockResolvedValueOnce(surveyRow({ status: 'SUBMITTED' }));
    await expect(as(undefined, () => svc.generateSuggestedQuestions('n1', []))).rejects.toThrow(
      code('SURVEY_NOT_EDITABLE'),
    );
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.generateSuggestedQuestions('n1', []))).rejects.toThrow(
      code('METHODOLOGY_VERSION_NOT_FOUND'),
    );
    tx.survey.findFirst.mockResolvedValueOnce(surveyRow({ status: 'SUBMITTED' }));
    tx.need.findUnique.mockResolvedValueOnce({ ...need, study: null });
    await as(undefined, () =>
      svc.generateSuggestedQuestions('n1', [], { allowWhileSubmitted: true }),
    ).catch(() => undefined);
  });
});

describe('SurveysService.updateQuestions', () => {
  const item = (over: Record<string, unknown> = {}) => ({ order: 1, isRequired: true, ...over });

  it('rejects an item that is both, or neither, bank and custom', async () => {
    const { svc } = setup();
    await expect(
      svc.updateQuestions('s1', [item({ questionId: 'q', customText: 'c' })]),
    ).rejects.toThrow(code('INVALID_SURVEY_QUESTION'));
    await expect(svc.updateQuestions('s1', [item()])).rejects.toThrow(
      code('INVALID_SURVEY_QUESTION'),
    );
  });

  it('saves bank and custom items and audits removals with their reasons', async () => {
    const { svc, tx, audit } = setup();
    tx.survey.findUnique.mockResolvedValue(surveyRow({ status: 'SUBMITTED' }));
    tx.surveyQuestion.findMany.mockResolvedValue([
      { id: 'keep', customText: null, question: { questionText: 'Q' } },
      { id: 'gone1', customText: null, question: { questionText: 'Bank text' } },
      { id: 'gone2', customText: 'Custom text', question: null },
      { id: 'gone3', customText: null, question: null },
    ]);
    await as('human_reviewer', () =>
      svc.updateQuestions(
        's1',
        [
          item({ id: 'keep', questionId: 'q1' }),
          item({ customText: 'New', customOptions: ['a'], domain: 'D', subDomain: 'S', kpi: 'K' }),
          item({ customText: 'Bare' }),
        ],
        { gone1: 'r1', gone2: 'r2', gone3: 'r3' },
      ),
    );
    const rows = tx.surveyQuestion.createMany.mock.calls[0]![0].data;
    expect(rows[0]).toMatchObject({ questionId: 'q1', customAnswerType: null, domain: null });
    expect(rows[1]).toMatchObject({
      customText: 'New',
      customAnswerType: 'long_text',
      domain: 'D',
      kpi: 'K',
    });
    expect(rows[2]).toMatchObject({ domain: null });
    expect(audit.record.mock.calls[0]![0].changes.map((c: { field: string }) => c.field)).toEqual([
      'Question count',
      'Removed: Bank text',
      'Removed: Custom text',
      'Removed: Untitled question',
    ]);
  });

  it('blocks the researcher on a submitted survey and everyone on approved or published ones', async () => {
    const { svc, tx } = setup();
    const one = [item({ questionId: 'q' })];
    for (const status of ['SUBMITTED', 'APPROVED', 'PUBLISHED']) {
      tx.survey.findUnique.mockResolvedValueOnce(surveyRow({ status }));
      await expect(
        as('ngo_research_officer', () => svc.updateQuestions('s1', one)),
      ).rejects.toThrow(code('SURVEY_NOT_EDITABLE'));
    }
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.updateQuestions('s1', one))).rejects.toThrow(
      code('SURVEY_NOT_FOUND'),
    );
  });
});

describe('SurveysService.createNewVersion', () => {
  it('copies a published survey into a new draft version and audits it', async () => {
    const { svc, tx, audit } = setup();
    tx.survey.findUnique
      .mockResolvedValueOnce(
        surveyRow({
          status: 'PUBLISHED',
          surveyQuestions: [sq({ questionId: 'q1', customOptions: null })],
        }),
      )
      .mockResolvedValueOnce(null);
    tx.survey.create.mockResolvedValue({ id: 'v2' });
    tx.survey.findFirst.mockResolvedValue(null);
    await as('ngo_research_officer', () => svc.createNewVersion('s1'));
    expect(tx.survey.create.mock.calls[0]![0].data).toMatchObject({
      version: 2,
      previousVersionId: 's1',
    });
    expect(tx.surveyQuestion.createMany).toHaveBeenCalled();
    expect(audit.record.mock.calls[0]![0].metadata).toBeDefined();
  });

  it('copies no questions when there are none, and reuses an existing next version', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique
      .mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED', surveyQuestions: [] }))
      .mockResolvedValueOnce(null);
    tx.survey.create.mockResolvedValue({ id: 'v2' });
    await as(undefined, () => svc.createNewVersion('s1'));
    expect(tx.surveyQuestion.createMany).not.toHaveBeenCalled();
    tx.survey.findUnique
      .mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED' }))
      .mockResolvedValueOnce({ id: 'existing' });
    await as(undefined, () => svc.createNewVersion('s1'));
    expect(tx.survey.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown or unpublished survey', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.createNewVersion('s1'))).rejects.toThrow(
      code('SURVEY_NOT_FOUND'),
    );
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow());
    await expect(as(undefined, () => svc.createNewVersion('s1'))).rejects.toThrow(
      code('SURVEY_NOT_PUBLISHED'),
    );
  });
});

describe('SurveysService methodology / sample / workflow edge cases', () => {
  it('setMethodologyVersion validates the version and the survey', async () => {
    const { svc, tx, audit } = setup();
    await expect(as(undefined, () => svc.setMethodologyVersion('s1', 'nope'))).rejects.toThrow(
      code('INVALID_METHODOLOGY_VERSION'),
    );
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.setMethodologyVersion('s1', 'v1'))).rejects.toThrow(
      code('SURVEY_NOT_FOUND'),
    );
    tx.survey.findUnique.mockResolvedValue(surveyRow());
    tx.survey.findFirst.mockResolvedValue(null);
    await as('ngo_research_officer', () => svc.setMethodologyVersion('s1', 'v1'));
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('setSampleDescription refuses an unknown survey', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(
      as(undefined, () => svc.setSampleDescription('s1', 'a', 1, 'b', 'c')),
    ).rejects.toThrow(code('SURVEY_NOT_FOUND'));
  });

  it('submitForApproval, approveSurvey, publishSurvey and rejectSurvey refuse unknown surveys', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue(null);
    await expect(svc.submitForApproval('s1')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
    await expect(svc.approveSurvey('s1', 'ok')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
    await expect(svc.publishSurvey('s1')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
    await expect(svc.rejectSurvey('s1', 'REJ_99' as never, 'ok')).rejects.toThrow(
      code('SURVEY_NOT_FOUND'),
    );
  });

  it('submitForApproval enforces status, questions and methodology', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED' }));
    await expect(svc.submitForApproval('s1')).rejects.toThrow(code('SURVEY_NOT_SUBMITTABLE'));
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow());
    tx.surveyQuestion.count.mockResolvedValueOnce(0);
    await expect(svc.submitForApproval('s1')).rejects.toThrow(code('SURVEY_HAS_NO_QUESTIONS'));
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow({ methodologyVersion: null }));
    tx.surveyQuestion.count.mockResolvedValueOnce(2);
    await expect(svc.submitForApproval('s1')).rejects.toThrow(
      code('SURVEY_NO_METHODOLOGY_VERSION'),
    );
  });

  it('publishing a new version supersedes the previous one', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue(
      surveyRow({ status: 'APPROVED', previousVersionId: 'old' }),
    );
    tx.survey.update.mockResolvedValue({ id: 's1' });
    await as(undefined, () => svc.publishSurvey('s1'));
    expect(tx.survey.update).toHaveBeenLastCalledWith({
      where: { id: 'old' },
      data: { status: 'SUPERSEDED' },
    });
  });

  it('refuses to approve or reject a survey that is not awaiting approval', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValue(surveyRow({ status: 'PUBLISHED' }));
    await expect(svc.approveSurvey('s1', 'ok')).rejects.toThrow(
      code('SURVEY_NOT_PENDING_APPROVAL'),
    );
    await expect(svc.rejectSurvey('s1', 'REJ_99' as never, 'ok')).rejects.toThrow(
      code('SURVEY_NOT_PENDING_APPROVAL'),
    );
  });
});

describe('SurveysService public flow', () => {
  it('returns a published survey and refuses a missing or unpublished one', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED' }));
    expect((await svc.getPublicSurvey('s1')).questions).toHaveLength(1);
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getPublicSurvey('s1')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow());
    await expect(svc.getPublicSurvey('s1')).rejects.toThrow(code('SURVEY_NOT_PUBLISHED'));
  });

  it('stores a submission only for a published survey', async () => {
    const { svc, tx } = setup();
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(svc.submitSurvey('s1', {})).rejects.toThrow(code('SURVEY_NOT_FOUND'));
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow());
    await expect(svc.submitSurvey('s1', {})).rejects.toThrow(code('SURVEY_NOT_PUBLISHED'));
    tx.survey.findUnique.mockResolvedValueOnce(surveyRow({ status: 'PUBLISHED' }));
    await svc.submitSurvey('s1', { a: 'b' });
    expect(tx.surveyBuilderResponse.create).toHaveBeenCalledWith({
      data: { surveyId: 's1', answers: { a: 'b' } },
    });
  });

  it('summarises responses per answer type', async () => {
    const { svc, tx } = setup();
    const many = (n: number, over: Record<string, unknown>) =>
      sq({ id: `q${n}`, order: n, question: bankQ(over) });
    tx.survey.findUnique.mockResolvedValueOnce({
      id: 's1',
      title: 'T',
      status: 'PUBLISHED',
      surveyQuestions: [
        many(1, { answerType: 'select', answerOptions: ['a', 'b'] }),
        many(2, { answerType: 'boolean', answerOptions: null }),
        many(3, { answerType: 'select', answerOptions: null }),
        many(4, { answerType: 'numeric' }),
        many(5, { answerType: 'long_text' }),
        sq({ id: 'c', question: null, customText: 'free' }),
      ],
      builderResponses: [
        { answers: { q1: 'a', q2: 'Yes', q3: "Don't know", q4: '10', q5: 'hello' } },
        { answers: { q1: 'b', q4: '20', q5: 'w' } },
        { answers: { q4: '45' } },
        { answers: { q4: '90' } },
        { answers: { q4: 'abc' } },
        { answers: null },
      ],
    });
    const out = await svc.getSurveyResponses('s1');
    expect(out.totalRespondents).toBe(6);
    expect(out.stats[0]!.slices!.map((s) => s.count)).toEqual([1, 1]);
    expect(out.stats[1]!.slices!.map((s) => s.label)).toEqual(['Yes', 'No']);
    expect(out.stats[2]!.slices![0]!.count).toBe(1);
    expect(out.stats[3]!.slices!.map((s) => s.count)).toEqual([1, 1, 1, 1]);
    expect(out.stats[4]).toMatchObject({ textResponses: ['hello', 'w'] });
    tx.survey.findUnique.mockResolvedValueOnce({
      id: 's',
      title: 't',
      status: 'PUBLISHED',
      surveyQuestions: [
        many(1, { answerType: 'select', answerOptions: ['a'] }),
        many(4, { answerType: 'numeric' }),
      ],
      builderResponses: [],
    });
    const empty = await svc.getSurveyResponses('s');
    expect(empty.stats[0]!.slices![0]!.percentage).toBe(0);
    expect(empty.stats[1]!.slices![0]!.percentage).toBe(0);
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getSurveyResponses('s')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
  });
});

describe('SurveysService.listSurveys and getSurveyDetailById', () => {
  const listed = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    title: 'T',
    needId: 'n1',
    status: 'PUBLISHED',
    version: 1,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    need: {
      studyId: 'st',
      orgId: 'o',
      title: 'N',
      study: { title: 'Study' },
      org: { name: 'Org' },
      surveyResponses: [{ id: 'r' }],
    },
    ...over,
  });

  it('lists across organisations for a system admin, auditing the view', async () => {
    const { svc, tx, audit } = setup();
    tx.survey.findMany.mockResolvedValue([
      listed(),
      listed({ status: 'DRAFT', title: null, publishedAt: null, createdAt: null, need: null }),
    ]);
    tx.survey.count.mockResolvedValue(2);
    const out = await as('system_admin', () =>
      svc.listSurveys({
        organizationId: 'o',
        studyId: 's',
        status: 'PUBLISHED',
        search: 'x',
        limit: 999,
        offset: -5,
      }),
    );
    expect(out).toMatchObject({ total: 2, limit: 200, offset: 0 });
    expect(out.items[0]).toMatchObject({ orgName: 'Org', studyTitle: 'Study', responseCount: 1 });
    expect(out.items[1]).toMatchObject({
      title: 'Untitled Survey',
      studyId: null,
      responseCount: 0,
      publishedAt: null,
      createdAt: null,
    });
    expect(audit.record).toHaveBeenCalledOnce();
    await as('system_admin', () => svc.listSurveys({}));
    expect(audit.record.mock.calls[1]![0].entityLabel).toBe('All Platform Surveys');
  });

  it('lists without audit for other cross-org readers and reads own org otherwise', async () => {
    const { svc, tx, audit } = setup();
    tx.survey.findMany.mockResolvedValue([]);
    tx.survey.count.mockResolvedValue(0);
    await as('system_reviewer', () => svc.listSurveys({ limit: 0 }));
    await as('ngo_admin', () => svc.listSurveys({}));
    await svc.listSurveys({});
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns a survey detail, auditing a system admin and refusing an unknown id', async () => {
    const { svc, tx, audit } = setup();
    const full = (over: Record<string, unknown> = {}) => ({
      ...surveyRow({ status: 'PUBLISHED' }),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      publishedAt: new Date('2026-01-02T00:00:00Z'),
      need: {
        studyId: 'st',
        orgId: 'o',
        title: 'N',
        village: ['A', 'B'],
        domain: null,
        aiSuggestedDomain: 'AD',
        study: { title: 'S' },
        org: { name: 'O' },
        priorityScores: [{ overallScore: 7 }],
        _count: { evidence: 3 },
        surveyResponses: [{ id: 'r' }, { id: 'r2' }],
      },
      ...over,
    });
    tx.survey.findUnique.mockResolvedValueOnce(full());
    const admin = await as('system_admin', () => svc.getSurveyDetailById('s1'));
    expect(admin).toMatchObject({
      village: 'A, B',
      domainCategory: 'AD',
      score: 7,
      evidenceCount: 3,
      responseCount: 2,
    });
    expect(audit.record).toHaveBeenCalledOnce();
    tx.survey.findUnique.mockResolvedValueOnce({
      ...full({ need: null }),
      status: 'DRAFT',
      title: null,
      publishedAt: null,
      createdAt: null,
    });
    const draft = await as('ngo_admin', () => svc.getSurveyDetailById('s1'));
    expect(draft).toMatchObject({
      title: 'Untitled Survey',
      village: '—',
      domainCategory: '—',
      responseCount: 0,
      evidenceCount: 0,
      score: null,
    });
    tx.survey.findUnique.mockResolvedValueOnce(
      full({
        need: {
          village: 'Solo',
          domain: 'D',
          priorityScores: [],
          study: null,
          org: null,
          surveyResponses: [],
          _count: { evidence: 0 },
        },
      }),
    );
    expect((await svc.getSurveyDetailById('s1')).village).toBe('Solo');
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(as('system_admin', () => svc.getSurveyDetailById('s1'))).rejects.toThrow(
      code('SURVEY_NOT_FOUND'),
    );
    tx.survey.findUnique.mockResolvedValueOnce(null);
    await expect(svc.getSurveyDetailById('s1')).rejects.toThrow(code('SURVEY_NOT_FOUND'));
  });
});
