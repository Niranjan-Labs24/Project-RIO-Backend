import { describe, expect, it, vi } from 'vitest';
import { DeterministicScoringService } from './scoring.service';

const svc = () => new DeterministicScoringService({} as never);
const q = (over: Record<string, unknown> = {}) =>
  ({
    questionId: 'Q1',
    measurementMode: 'SINGLE_SELECT',
    isScoreable: true,
    conditionalRule: null,
    ...over,
  }) as never;
const lookup = (over: Record<string, unknown> = {}) =>
  ({
    id: 'lk',
    questionId: 'Q1',
    lookupType: 'MULTI_SELECT',
    optionId: 'A',
    severityScore: 10,
    isExcluded: false,
    exclusionReason: null,
    numericFloor: null,
    numericCeiling: null,
    severityDirection: null,
    ...over,
  }) as never;

describe('parseRawAnswerValue', () => {
  const parse = (raw: unknown, mode: string) => svc().parseRawAnswerValue(raw, mode);

  it('treats empty answers as nothing', () => {
    for (const raw of [null, undefined, ''])
      expect(parse(raw, 'SINGLE_SELECT')).toEqual({
        optionId: null,
        optionIds: null,
        numericValue: null,
        text: null,
      });
  });

  it('reads numbers, and ignores text that is not a number', () => {
    expect(parse('42', 'NUMERIC').numericValue).toBe(42);
    expect(parse('abc', 'NUMERIC').numericValue).toBeNull();
  });

  it('reads multiple choices from an array or a delimited string', () => {
    expect(parse(['Clean water', 'Food aid'], 'MULTI_SELECT').optionIds).toEqual([
      'CLEAN_WATER',
      'FOOD_AID',
    ]);
    expect(parse('a; b,c ,, ', 'CHECKLIST_MATRIX').optionIds).toEqual(['A', 'B', 'C']);
    expect(parse(5, 'MULTI_SELECT').optionIds).toBeNull();
  });

  it('keeps free text for modes that are not scored, and normalises single choices', () => {
    expect(parse('Some story', 'OPEN_TEXT').text).toBe('Some story');
    expect(parse('Very Bad', 'LIKERT_5').optionId).toBe('VERY_BAD');
  });
});

describe('evaluateConditionalRule', () => {
  const answers = (
    entries: Record<string, { optionId?: string | null; optionIds?: string[] | null }>,
  ) =>
    new Map(
      Object.entries(entries).map(([k, v]) => [
        k,
        {
          optionId: v.optionId ?? null,
          optionIds: v.optionIds ?? null,
          numericValue: null,
          text: null,
        },
      ]),
    );
  const rule = (r: unknown) => q({ conditionalRule: r });

  it('applies when there is no rule, no dependency, or a prose rule', () => {
    const s = svc();
    expect(s.evaluateConditionalRule(q(), new Map())).toBe(true);
    expect(s.evaluateConditionalRule(rule({}), new Map())).toBe(true);
    expect(s.evaluateConditionalRule(rule({ dependsOn: 'P', operator: 'PROSE' }), new Map())).toBe(
      true,
    );
  });

  it('does not apply when the parent question was not answered', () => {
    expect(
      svc().evaluateConditionalRule(rule({ dependsOn: 'P', values: ['Yes'] }), new Map()),
    ).toBe(false);
  });

  it('matches the wanted values against a single or multiple parent answer, in or not in', () => {
    const s = svc();
    const single = answers({ P: { optionId: 'YES' } });
    const multi = answers({ P: { optionIds: ['A', 'B'] } });
    expect(s.evaluateConditionalRule(rule({ dependsOn: 'P', values: ['Yes'] }), single)).toBe(true);
    expect(s.evaluateConditionalRule(rule({ dependsOn: 'P', value: 'No' }), single)).toBe(false);
    expect(s.evaluateConditionalRule(rule({ dependsOn: 'P', values: ['b'] }), multi)).toBe(true);
    expect(
      s.evaluateConditionalRule(
        rule({ dependsOn: 'P', operator: 'NOT_IN', values: ['Yes'] }),
        single,
      ),
    ).toBe(false);
    expect(
      s.evaluateConditionalRule(
        rule({ dependsOn: 'P', operator: 'NOT_IN', values: ['No'] }),
        single,
      ),
    ).toBe(true);
    expect(s.evaluateConditionalRule(rule({ dependsOn: 'P' }), single)).toBe(true); // nothing to match against
    expect(
      s.evaluateConditionalRule(rule({ dependsOn: 'P', values: ['x'] }), answers({ P: {} })),
    ).toBe(false);
  });

  it('reads a rule stored as JSON text, and applies the question when the rule is broken', () => {
    const s = svc();
    expect(
      s.evaluateConditionalRule(
        rule('{"dependsOn":"P","values":["Yes"]}'),
        answers({ P: { optionId: 'YES' } }),
      ),
    ).toBe(true);
    expect(s.evaluateConditionalRule(rule('{not json'), new Map())).toBe(true);
  });
});

describe('calculateSeverity — multiple choice', () => {
  const parsed = (optionIds: string[]) => ({
    optionId: null,
    optionIds,
    numericValue: null,
    text: null,
  });

  it('is not scored for a non-scoring mode', () => {
    expect(
      svc().calculateSeverity(q({ measurementMode: 'OPEN_TEXT' }), parsed([]), []),
    ).toMatchObject({ status: 'NOT_SCOREABLE' });
  });

  it('sums the selected options and caps at 100', () => {
    const lookups = [
      lookup({ optionId: 'A', severityScore: 60 }),
      lookup({ id: 'lk2', optionId: 'B', severityScore: 70 }),
    ];
    const result = svc().calculateSeverity(
      q({ measurementMode: 'MULTI_SELECT' }),
      parsed(['A', 'B']),
      lookups,
    );
    expect(result).toMatchObject({ score: 100, status: 'SCORED', scoringLookupId: 'lk' });
  });

  it('uses a combination lookup when one exists for exactly that selection', () => {
    const lookups = [
      lookup({ optionId: 'A', severityScore: 10 }),
      lookup({ id: 'combo', optionId: 'A__B', severityScore: 25 }),
    ];
    expect(
      svc().calculateSeverity(q({ measurementMode: 'MULTI_SELECT' }), parsed(['B', 'A']), lookups),
    ).toMatchObject({ score: 25, scoringLookupId: 'combo' });
  });

  it('excludes the whole answer when a selected option is excluded', () => {
    const lookups = [
      lookup({ optionId: 'A' }),
      lookup({ id: 'ex', optionId: 'B', isExcluded: true, exclusionReason: null }),
    ];
    expect(
      svc().calculateSeverity(q({ measurementMode: 'MULTI_SELECT' }), parsed(['A', 'B']), lookups),
    ).toMatchObject({
      status: 'EXCLUDED',
      scoringLookupId: 'ex',
      exclusionReason: 'NOT_APPLICABLE',
    });
  });

  it('reports an error when none of the selections has a lookup, and scores an empty selection as zero', () => {
    const s = svc();
    expect(
      s.calculateSeverity(q({ measurementMode: 'MULTI_SELECT' }), parsed(['ZZZ']), [lookup()]),
    ).toMatchObject({ status: 'ERROR', score: null });
    expect(
      s.calculateSeverity(q({ measurementMode: 'MULTI_SELECT' }), parsed([]), [lookup()]),
    ).toMatchObject({ score: 0, status: 'SCORED', scoringLookupId: 'lk' });
    expect(
      s.calculateSeverity(
        q({ measurementMode: 'MULTI_SELECT' }),
        { optionId: null, optionIds: null, numericValue: null, text: null },
        [lookup()],
      ),
    ).toMatchObject({ score: 0 });
    expect(() =>
      s.calculateSeverity(q({ measurementMode: 'MULTI_SELECT' }), parsed(['A']), []),
    ).toThrow('No MULTI_SELECT lookups');
  });

  it('uses the checklist lookup type for checklist matrices, and counts a missing score as zero', () => {
    const lookups = [lookup({ lookupType: 'CHECKLIST', optionId: 'A', severityScore: null })];
    expect(
      svc().calculateSeverity(q({ measurementMode: 'CHECKLIST_MATRIX' }), parsed(['A']), lookups),
    ).toMatchObject({ score: 0 });
  });
});

describe('calculateSeverity — numeric and single choice edge cases', () => {
  it('uses default bounds when the lookup has none, and the floor for a missing number', () => {
    const lookups = [
      lookup({
        lookupType: 'NUMERIC',
        numericFloor: null,
        numericCeiling: null,
        severityDirection: null,
      }),
    ];
    expect(
      svc().calculateSeverity(
        q({ measurementMode: 'NUMERIC' }),
        { optionId: null, optionIds: null, numericValue: 25, text: null },
        lookups,
      ).score,
    ).toBe(25);
    expect(
      svc().calculateSeverity(
        q({ measurementMode: 'NUMERIC' }),
        { optionId: null, optionIds: null, numericValue: null, text: null },
        lookups,
      ).score,
    ).toBe(0);
  });

  it('returns a null score for a matched option that has none, and excluded options with the default reason', () => {
    const s = svc();
    const parsed = { optionId: 'A', optionIds: null, numericValue: null, text: null };
    expect(
      s.calculateSeverity(q(), parsed, [lookup({ lookupType: 'OPTION', severityScore: null })]),
    ).toMatchObject({ score: null, status: 'SCORED' });
    expect(
      s.calculateSeverity(q(), parsed, [lookup({ lookupType: 'OPTION', isExcluded: true })]),
    ).toMatchObject({ status: 'EXCLUDED', exclusionReason: 'DONT_KNOW' });
  });

  it('gives no exclusion for an empty option or a lookup that is not excluded', () => {
    const s = svc();
    expect(s.getOptionExclusion(null, [], 'Q1')).toBeNull();
    expect(s.getOptionExclusion('A', [lookup({ optionId: 'A' })], 'Q1')).toBeNull();
    expect(
      s.getOptionExclusion(
        'A',
        [lookup({ optionId: 'A', isExcluded: true, exclusionReason: 'REFUSED' })],
        'Q1',
      ),
    ).toMatchObject({ exclusionReason: 'REFUSED' });
  });

  it('joins option ids in a stable order', () => {
    expect(svc().compositeOptionId(['B', '', 'A'])).toBe('A__B');
  });
});

describe('scoreResponse', () => {
  const response = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    needId: 'n1',
    studyId: 's1',
    orgId: 'org-1',
    contact: 'c@x',
    submittedAt: new Date(),
    answers: { sq1: 'Yes', sq2: 'x', sq3: '', sq4: 'Bad' },
    need: { village: ['V1'] },
    ...over,
  });

  function setup() {
    const tx = {
      surveyResponse: { findUnique: vi.fn().mockResolvedValue(response()) },
      survey: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sv1',
          methodologyVersion: 'v5.0',
          surveyQuestions: [
            { id: 'sq1', question: q({ questionId: 'Q1' }) },
            { id: 'sq2', question: q({ questionId: 'Q2', isScoreable: false }) },
            { id: 'sq3', question: q({ questionId: 'Q3' }) },
            { id: 'sq4', question: q({ questionId: 'Q4' }) },
            {
              id: 'sq5',
              question: q({
                questionId: 'Q5',
                conditionalRule: { dependsOn: 'NOPE', values: ['x'] },
              }),
            },
            { id: 'sq6', question: null },
          ],
        }),
      },
      methodologyVersion: { findFirst: vi.fn().mockResolvedValue({ id: 'mv1' }) },
      responseAnswer: {
        deleteMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'a1' }),
        update: vi.fn(),
      },
      scoringLookup: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            lookup({ questionId: 'Q1', lookupType: 'OPTION', optionId: 'YES', severityScore: 0 }),
            lookup({
              id: 'lk4',
              questionId: 'Q4',
              lookupType: 'OPTION',
              optionId: 'BAD',
              isExcluded: true,
              exclusionReason: 'DONT_KNOW',
            }),
          ]),
      },
      responseSeverityScore: { create: vi.fn() },
    };
    const tenant = {
      runInOrgContext: async (fn: (t: unknown) => unknown) => fn(tx),
      runAsOrg: async (_o: string, fn: (t: unknown) => unknown) => fn(tx),
    };
    return { tx, svc: new DeterministicScoringService(tenant as never) };
  }

  it('scores every answer of a response and records why the others were not scored', async () => {
    const { svc: s, tx } = setup();
    await s.scoreResponse('r1');
    const statuses = Object.fromEntries(
      tx.responseSeverityScore.create.mock.calls.map((c) => [
        c[0].data.questionId,
        c[0].data.scoreStatus,
      ]),
    );
    expect(statuses).toEqual({
      Q1: 'SCORED',
      Q2: 'NOT_SCOREABLE',
      Q3: 'EXCLUDED',
      Q4: 'EXCLUDED',
      Q5: 'NOT_APPLICABLE',
    });
    expect(tx.responseAnswer.deleteMany).toHaveBeenCalled();
  });

  it('runs for a given organization, and records an error when a lookup is missing', async () => {
    const { svc: s, tx } = setup();
    tx.scoringLookup.findMany.mockResolvedValue([]);
    tx.surveyResponse.findUnique.mockResolvedValue(
      response({ need: { village: [] }, answers: null }),
    );
    await s.scoreResponse('r1', 'org-9');
    const created = tx.responseSeverityScore.create.mock.calls.map((c) => c[0].data);
    expect(created.every((d) => d.villageId === null)).toBe(true);
    tx.surveyResponse.findUnique.mockResolvedValue(response({ answers: { sq1: 'Yes' } }));
    await s.scoreResponse('r1');
    expect(
      tx.responseSeverityScore.create.mock.calls.some((c) => c[0].data.scoreStatus === 'ERROR'),
    ).toBe(true);
  });

  it('fails clearly when the response, survey or methodology version is missing', async () => {
    const { svc: s, tx } = setup();
    tx.surveyResponse.findUnique.mockResolvedValueOnce(null);
    await expect(s.scoreResponse('x')).rejects.toThrow('SurveyResponse not found');
    tx.survey.findFirst.mockResolvedValueOnce(null);
    await expect(s.scoreResponse('r1')).rejects.toThrow('No published survey');
    tx.methodologyVersion.findFirst.mockResolvedValueOnce(null);
    await expect(s.scoreResponse('r1')).rejects.toThrow('No published methodology version');
  });

  it('uses the published methodology version when the survey names none', async () => {
    const { svc: s, tx } = setup();
    tx.survey.findFirst.mockResolvedValue({
      id: 'sv1',
      methodologyVersion: null,
      surveyQuestions: [],
    });
    await s.scoreResponse('r1');
    expect(tx.methodologyVersion.findFirst.mock.calls[0]![0].where).toEqual({
      status: 'PUBLISHED',
    });
  });
});
