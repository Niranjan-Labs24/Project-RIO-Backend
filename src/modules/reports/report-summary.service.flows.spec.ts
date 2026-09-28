import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../../tenancy/org-context';

const m = vi.hoisted(() => ({
  aggregate: vi.fn(),
  basis: vi.fn(),
  localize: vi.fn(),
  aliases: vi.fn(),
  mapper: vi.fn((a: unknown) => ({ mapped: a })),
}));
vi.mock('./providers/aggregate-demographics', () => ({ aggregateDemographics: m.aggregate }));
vi.mock('./providers/load-sector-scope-basis', () => ({ loadSectorScopeBasis: m.basis }));
vi.mock('../translation/summary-localization', () => ({ localizeSummaryOutput: m.localize }));
vi.mock('./i18n/master-data-names', () => ({ loadMasterDataAliases: m.aliases }));
vi.mock('./providers/snapshot-to-content', () => ({
  snapshotToSectorContent: (a: unknown) => ({ kind: 'sector', a }),
  snapshotToRegionContent: (a: unknown) => ({ kind: 'region', a }),
  snapshotToExecutiveContent: (a: unknown) => ({ kind: 'executive', a }),
  snapshotToVillageContent: (a: unknown) => ({ kind: 'village', a }),
}));

import {
  ReportSummaryService,
  scopeFiltersMatch,
  type SummaryScopeType,
} from './report-summary.service';

type Fn = ReturnType<typeof vi.fn>;
// Every model/method is created on demand, so indexing can never be undefined.
type FakeTx = any;

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
  const tenant = { runInOrgContext: call, runAsSupervisor: call, runRead: call };
  const ai = { run: vi.fn(), resolveModelName: vi.fn().mockReturnValue('model-x') };
  const svc = new ReportSummaryService(tenant as never, ai as never);
  return { tx, ai, svc };
}

const as = <T>(role: string | undefined, fn: () => Promise<T>, locale?: 'en' | 'ar') =>
  orgContext.run({ requestId: 'r', orgId: 'org-1', actorId: 'u1', role, locale } as never, fn);

const rollup = (over: Record<string, unknown> = {}) => ({
  entityId: 'Water',
  entityNameSnapshot: 'Water',
  severityScore: 55,
  confidenceLevel: 'HIGH',
  validResponseCount: 9,
  excludedResponseCount: 1,
  dontKnowRate: 0.1,
  dontKnowCount: 2,
  notApplicableCount: 0,
  ...over,
});

function seed(
  tx: FakeTx,
  over: { survey?: unknown; overall?: unknown; assessment?: unknown; evidence?: unknown[] } = {},
) {
  tx.study.findUnique.mockResolvedValue({
    id: 'st',
    title: 'Study',
    cycleNumber: 2,
    org: { name: 'Org' },
    villages: ['V'],
    population: 100,
    requiredSampleSize: 30,
    minimumDetectableEffect: 0.1,
    studyGovernorates: [
      {
        governorateId: 'g1',
        governorate: { name: 'Gov', regionId: 'r1', region: { name: 'Reg' } },
      },
      {
        governorateId: 'g2',
        governorate: { name: 'Gov2', regionId: 'r1', region: { name: 'Reg' } },
      },
    ],
  });
  tx.survey.findUnique.mockResolvedValue(
    over.survey === undefined ? { id: 'sv', needId: 'n1', methodologyVersion: 'v1' } : over.survey,
  );
  tx.surveyResponse.findMany.mockResolvedValue([{}, {}, {}]);
  tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv', version: 'v1' });
  tx.scoreRollup.findFirst.mockResolvedValue(
    over.overall === undefined ? rollup({ severityScore: 72, dontKnowRate: 0.05 }) : over.overall,
  );
  tx.scoreRollup.findMany.mockResolvedValue([rollup()]);
  tx.question.findMany.mockResolvedValue([
    { domain: 'Water', kpi: 'K1', indicator: 'I1' },
    { domain: 'Water', kpi: 'K1', indicator: 'I2' },
    { domain: 'Water', kpi: 'K2', indicator: null },
    { domain: 'Water', kpi: null, indicator: null },
  ]);
  tx.surveyQuestion.findMany.mockResolvedValue([
    { domain: null, question: { domain: 'Water' } },
    { domain: 'Water', question: null },
    { domain: 'Health', question: null },
    { domain: null, question: null },
  ]);
  tx.need.findUnique.mockResolvedValue({ village: ['V'] });
  tx.needGovernorate.findMany.mockResolvedValue([
    { governorateId: 'g1', governorate: { name: 'Gov', regionId: 'r1', region: { name: 'Reg' } } },
  ]);
  tx.needCenter.findMany.mockResolvedValue([{ centerId: 'c1', center: { name: 'Center' } }]);
  tx.villagePriorityAssessment.findFirst.mockResolvedValue(
    over.assessment === undefined ? null : over.assessment,
  );
  tx.evidence.findMany.mockResolvedValue(over.evidence ?? []);
}

describe('scopeFiltersMatch', () => {
  it('treats absent, empty and reordered filters as equal', () => {
    expect(scopeFiltersMatch({}, { villageId: '', villageIds: [] })).toBe(true);
    expect(scopeFiltersMatch({ villageIds: ['a', 'b'] }, { villageIds: ['b', 'a'] })).toBe(true);
    expect(scopeFiltersMatch({ domainKey: 'x' }, {})).toBe(false);
  });
});

describe('ReportSummaryService.buildReportDataSnapshot', () => {
  it('builds a survey-level snapshot with hashes, geography, evidence and priority', async () => {
    const { svc, tx } = setup();
    seed(tx, {
      assessment: {
        priorityScore: 35,
        priorityStatus: 'HIGH',
        overrideApplied: true,
        overrideReason: 'r',
        calculatedAt: new Date('2026-01-01T00:00:00Z'),
        domainComponents: [
          {
            domainKey: 'WATER',
            domainNameSnapshot: 'Water',
            domainSeverityScore: 1,
            domainPerformanceScore: 2,
            domainWeight: 3,
            weightedContribution: 4,
            isCriticalDomain: true,
            triggeredOverride: false,
          },
        ],
      },
      evidence: [
        {
          id: 'abcdefghijkl',
          title: '',
          fileName: 'f.pdf',
          fileType: 'pdf',
          sourceReferenceId: null,
          linkedDomainOrKpi: null,
          description: null,
          collectedAt: null,
          uploadedAt: new Date('2026-01-01T00:00:00Z'),
        },
        {
          id: 'e2',
          title: 'T',
          fileName: 'f',
          fileType: 'doc',
          sourceReferenceId: 'S',
          linkedDomainOrKpi: 'Water',
          description: 'd',
          collectedAt: new Date('2026-02-01T00:00:00Z'),
          uploadedAt: new Date(),
        },
      ],
    });
    const out = await as('ngo_admin', () =>
      svc.buildReportDataSnapshot('st', 'sv', 'VILLAGE', { villageId: 'V' }),
    );
    expect(out.snapshot.snapshotId).toMatch(/^snap-[0-9a-f]{16}$/);
    expect(out.snapshot.severity.severityBand).toBe('CRITICAL');
    expect(out.snapshot.priority).toMatchObject({
      villagePriorityScore: 35,
      priorityStatus: 'HIGH',
      overrideApplied: true,
    });
    expect(out.snapshot.evidence.map((e) => e.sourceReferenceId)).toEqual(['abcdefgh', 'S']);
    expect(out.snapshot.severity.domainSeverityScores[0]!.kpiCount).toBe(2);
    expect(out.snapshot.questionsAskedByDomain.map((q) => q.count)).toEqual([2, 1]);
    expect(out.snapshot.study.villageName).toBe('V');
  });

  it('builds an aggregate snapshot for a cross-org reader, with defaults for missing data', async () => {
    const { svc, tx } = setup();
    seed(tx, { overall: null });
    tx.scoreRollup.findMany.mockResolvedValue([
      rollup({ entityId: 'Water', severityScore: null }),
      rollup({ entityId: 'Health' }),
    ]);
    const out = await as('system_admin', () =>
      svc.buildReportDataSnapshot('st', 'sv', 'SECTOR', { domainKey: 'WATER' }),
    );
    expect(out.snapshot.severity.severityBand).toBe('UNSCORED');
    expect(out.snapshot.priority.villagePriorityScore).toBeNull();
    expect(out.snapshot.responseQuality.validResponseCount).toBe(3);
    expect(out.snapshot.study.villageId).toBe('ALL_VILLAGES');
    expect(tx.evidence.findMany.mock.calls[0]![0].where).toMatchObject({ studyId: 'st' });
    expect(tx.need.findUnique).not.toHaveBeenCalled();
  });

  it('gives INDIVIDUAL summaries no document evidence, and bands the severity levels', async () => {
    const { svc, tx } = setup();
    for (const [score, band] of [
      [55, 'HIGH'],
      [35, 'MEDIUM'],
      [10, 'LOW'],
    ] as const) {
      seed(tx, { overall: rollup({ severityScore: score }) });
      const out = await as('center_supervisor', () =>
        svc.buildReportDataSnapshot('st', 'sv', 'INDIVIDUAL'),
      );
      expect(out.snapshot.severity.severityBand).toBe(band);
    }
    expect(tx.evidence.findMany).not.toHaveBeenCalled();
    seed(tx);
    tx.need.findUnique.mockResolvedValue(null);
    await as('system_reviewer', () => svc.buildReportDataSnapshot('st', 'sv', 'COMBINED'));
    expect(tx.evidence.findMany.mock.calls[0]![0].where).toMatchObject({ needId: 'n1' });
  });

  it('handles a study with no governorates', async () => {
    const { svc, tx } = setup();
    seed(tx);
    tx.study.findUnique.mockResolvedValue({
      id: 'st',
      title: 'S',
      cycleNumber: 1,
      org: { name: 'O' },
      villages: null,
      studyGovernorates: [],
    });
    const out = await svc.previewSnapshot('st', 'sv', 'EXECUTIVE');
    expect(out.snapshot.study.governorateName).toBeNull();
  });

  it('refuses a missing study, survey or methodology version', async () => {
    const { svc, tx } = setup();
    seed(tx);
    tx.study.findUnique.mockResolvedValueOnce(null);
    await expect(svc.buildReportDataSnapshot('st', 'sv')).rejects.toThrow('Study not found');
    seed(tx, { survey: null });
    await expect(svc.buildReportDataSnapshot('st', 'sv')).rejects.toThrow('Survey not found');
    seed(tx);
    tx.methodologyVersion.findFirst.mockResolvedValue(null);
    await expect(svc.buildReportDataSnapshot('st', 'sv')).rejects.toThrow('No methodology version');
    seed(tx, { survey: { id: 'sv', needId: 'n1', methodologyVersion: null } });
    tx.methodologyVersion.findFirst.mockResolvedValue({ id: 'mv', version: 'v1' });
    await svc.buildReportDataSnapshot('st', 'sv');
    expect(tx.methodologyVersion.findFirst.mock.calls.at(-1)![0].where).toEqual({
      status: 'PUBLISHED',
    });
  });
});

describe('ReportSummaryService.generatePrioritySummary', () => {
  const scopes: SummaryScopeType[] = [
    'VILLAGE',
    'SECTOR',
    'REGION',
    'EXECUTIVE',
    'INDIVIDUAL',
    'COMBINED',
  ];

  it('has a distinct prompt version lookup for every scope', () => {
    const { svc } = setup();
    for (const s of scopes) expect(typeof svc.promptVersionFor(s)).toBe('string');
    expect(svc.promptVersionFor('INDIVIDUAL')).not.toBe(svc.promptVersionFor('COMBINED'));
  });

  it('generates a draft for every scope, superseding older drafts', async () => {
    const { svc, tx, ai } = setup();
    seed(tx);
    ai.run.mockResolvedValue({ response: { headline: 'h' } });
    tx.aiPrioritySummary.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    for (const scope of scopes) {
      const out = await as('ngo_admin', () =>
        svc.generatePrioritySummary('st', 'sv', scope, { villageId: 'V' }, { extra: 1 }),
      );
      expect(out.summary).toMatchObject({
        summaryScope: scope,
        status: 'DRAFT',
        outputLocale: 'en',
        modelName: 'model-x',
      });
    }
    expect(tx.aiPrioritySummary.updateMany).toHaveBeenCalledTimes(scopes.length);
  });

  it('adds an Arabic glossary when the requester views the app in Arabic, and survives a glossary failure', async () => {
    const { svc, tx, ai } = setup();
    seed(tx);
    ai.run.mockResolvedValue({ response: {} });
    tx.aiPrioritySummary.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    m.aliases.mockResolvedValueOnce(new Map([['water', 'ماء']]));
    await as(
      'ngo_admin',
      () => svc.generatePrioritySummary('st', 'sv', 'VILLAGE', {}, { note: 'Water' }),
      'ar',
    );
    expect(ai.run.mock.calls[0]![1]).toContain('ماء');
    m.aliases.mockRejectedValueOnce(new Error('down'));
    await as(undefined, () => svc.generatePrioritySummary('st', 'sv'), 'ar');
    m.aliases.mockRejectedValueOnce('str');
    await as(undefined, () => svc.generatePrioritySummary('st', 'sv'), 'ar');
    m.aliases.mockResolvedValueOnce(new Map());
    await as(undefined, () => svc.generatePrioritySummary('st', 'sv'), 'ar');
  });

  it('refuses to summarise when there are no responses or no scoring', async () => {
    const { svc, tx } = setup();
    seed(tx, { overall: null });
    await expect(as(undefined, () => svc.generatePrioritySummary('st', 'sv'))).rejects.toThrow(
      'Cannot generate AI Summary',
    );
    seed(tx);
    tx.surveyResponse.findMany.mockResolvedValue([]);
    await expect(as(undefined, () => svc.generatePrioritySummary('st', 'sv'))).rejects.toThrow(
      'Cannot generate AI Summary',
    );
  });
});

describe('ReportSummaryService reads and localisation', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'a',
    aiOutputJson: { x: 1 },
    officerEditedOutputJson: null,
    outputLocale: 'en',
    localizedOutputs: null,
    scopeFilters: null,
    ...over,
  });

  it('returns the summary matching the requested filters together with a localized output', async () => {
    const { svc, tx } = setup();
    seed(tx);
    tx.aiPrioritySummary.findMany.mockResolvedValue([
      stored({ scopeFilters: { domainKey: 'X' } }),
      stored({ id: 'b' }),
    ]);
    m.localize.mockResolvedValue({ output: { y: 1 } });
    const out = await as(undefined, () => svc.getSummary('st', 'sv', 'VILLAGE', ''));
    expect(out!.summary.id).toBe('b');
    expect(out!.localized).toEqual({ output: { y: 1 } });
    tx.aiPrioritySummary.findMany.mockResolvedValue([]);
    expect(
      await as(undefined, () => svc.getSummary('st', 'sv', 'VILLAGE', { villageId: 'V' })),
    ).toBeNull();
    expect(await as(undefined, () => svc.getSummary('st', 'sv'))).toBeNull();
  });

  it('localizedOutput persists a fresh translation best-effort, tolerating a cache failure', async () => {
    const { svc, tx } = setup();
    m.localize.mockResolvedValue({ output: {}, toPersist: { ar: {} } });
    await as(undefined, () =>
      svc.localizedOutput(stored({ officerEditedOutputJson: { e: 1 }, outputLocale: 'ar' }), 'en'),
    );
    expect(m.localize.mock.calls.at(-1)![1]).toMatchObject({
      source: { e: 1 },
      sourceLocale: 'ar',
      targetLocale: 'en',
    });
    expect(tx.aiPrioritySummary.updateMany).toHaveBeenCalled();
    tx.aiPrioritySummary.updateMany.mockRejectedValueOnce(new Error('db'));
    await as(undefined, () => svc.localizedOutput(stored()));
    tx.aiPrioritySummary.updateMany.mockRejectedValueOnce('str');
    await as(undefined, () => svc.localizedOutput(stored()));
    m.localize.mockResolvedValue({ output: {} });
    await as(undefined, () => svc.localizedOutput(stored()));
  });
});

describe('ReportSummaryService editing and saving', () => {
  it('edits, confirms, saves and deletes a summary, and refuses unknown ids', async () => {
    const { svc, tx } = setup();
    tx.aiPrioritySummary.findFirst.mockResolvedValue({ id: 'a' });
    await as(undefined, () => svc.saveDraftEdits('a', { x: 1 }));
    await as('ngo_admin', () => svc.confirmSummary('a'));
    expect(tx.aiPrioritySummary.update.mock.calls[1]![0].data.officerConfirmedBy).toBe('u1');
    await as(undefined, () => svc.saveSummary('a', { e: 1 }));
    await as(undefined, () => svc.saveSummary('a'));
    expect(tx.aiPrioritySummary.update.mock.calls[2]![0].data.officerEditedOutputJson).toEqual({
      e: 1,
    });
    expect(tx.aiPrioritySummary.update.mock.calls[3]![0].data).not.toHaveProperty(
      'officerEditedOutputJson',
    );
    await as(undefined, () => svc.deleteSavedSummary('a'));
    tx.aiPrioritySummary.findFirst.mockResolvedValue(null);
    for (const fn of [
      () => svc.saveDraftEdits('a', {}),
      () => svc.confirmSummary('a'),
      () => svc.saveSummary('a'),
      () => svc.deleteSavedSummary('a'),
    ]) {
      await expect(as(undefined, fn)).rejects.toThrow('Summary not found');
    }
  });

  it('lists history and saved summaries, and invalidates stale ones', async () => {
    const { svc, tx } = setup();
    await as(undefined, () => svc.getSummaryHistory('st', 'sv'));
    await as(undefined, () => svc.getSavedSummariesList('st', 'sv'));
    await as(undefined, () => svc.invalidateIfStale('st', 'sv'));
    expect(tx.aiPrioritySummary.findMany).toHaveBeenCalledTimes(2);
    expect(tx.aiPrioritySummary.updateMany.mock.calls[0]![0].data).toEqual({ status: 'STALE' });
  });

  it('toggles evidence inclusion and marks summaries stale', async () => {
    const { svc, tx } = setup();
    tx.evidence.findFirst.mockResolvedValue({ id: 'e', studyId: 'st' });
    await as(undefined, () => svc.toggleEvidenceInclusion('e', false));
    expect(tx.aiPrioritySummary.updateMany).toHaveBeenCalled();
    tx.evidence.findFirst.mockResolvedValue(null);
    await expect(as(undefined, () => svc.toggleEvidenceInclusion('e', true))).rejects.toThrow(
      'Evidence not found',
    );
  });

  it('saves a confirmed summary as a report of the right type per scope', async () => {
    const { svc, tx } = setup();
    seed(tx);
    m.aggregate.mockResolvedValue({ demo: 1 });
    m.basis.mockResolvedValue('basis');
    m.localize.mockResolvedValue({ output: { o: 1 } });
    tx.report.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    const confirmed = (scope: string | null, filters: unknown = { villageId: 'V' }) => ({
      id: 'a',
      studyId: 'st',
      surveyId: 'sv',
      status: 'OFFICER_CONFIRMED',
      summaryScope: scope,
      scopeFilters: filters,
      aiOutputJson: {},
      officerEditedOutputJson: null,
      outputLocale: 'en',
      localizedOutputs: null,
    });
    const expectations: Array<[string | null, string, string]> = [
      ['SECTOR', 'RPT04', 'Sector Report — Study'],
      ['REGION', 'RPT06', 'Region Report — Study'],
      ['EXECUTIVE', 'RPT13', 'Executive Report — Study'],
      ['VILLAGE', 'RPT14', 'Village Report — V'],
      [null, 'RPT14', 'Village Report — V'],
    ];
    for (const [scope, type, title] of expectations) {
      tx.aiPrioritySummary.findFirst.mockResolvedValue(confirmed(scope));
      const out = await as(undefined, () => svc.saveReportFromSummary('a'));
      expect(out).toMatchObject({ reportType: type, title });
    }
    tx.aiPrioritySummary.findFirst.mockResolvedValue(confirmed('VILLAGE', null));
    await as(undefined, () => svc.saveReportFromSummary('a'));
  });

  it('refuses to save an unknown, unconfirmed or survey-level summary as a report', async () => {
    const { svc, tx } = setup();
    seed(tx);
    m.aggregate.mockResolvedValue(null);
    m.localize.mockResolvedValue({ output: {} });
    tx.aiPrioritySummary.findFirst.mockResolvedValueOnce(null);
    await expect(as(undefined, () => svc.saveReportFromSummary('a'))).rejects.toThrow(
      'Summary not found',
    );
    tx.aiPrioritySummary.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
    await expect(as(undefined, () => svc.saveReportFromSummary('a'))).rejects.toThrow(
      'OFFICER_CONFIRMED',
    );
    for (const scope of ['INDIVIDUAL', 'COMBINED']) {
      tx.aiPrioritySummary.findFirst.mockResolvedValueOnce({
        status: 'OFFICER_CONFIRMED',
        studyId: 'st',
        surveyId: 'sv',
        summaryScope: scope,
        scopeFilters: {},
      });
      await expect(as(undefined, () => svc.saveReportFromSummary('a'))).rejects.toThrow(
        'POST /reports',
      );
    }
  });
});
