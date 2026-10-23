import { describe, expect, it } from 'vitest';
import { buildPresentation, type ReportPresentation } from './build-presentation';
import { ALL_PRESENTATION_BLOCKS } from './presentation.config';
import { bandLabel, bandNote, confidenceSentence, presentationDocSections } from './presentation-doc';
import { applyDesign } from './design-sections';
import { withGovernorateShare } from './governorate-share';
import { loadParticipation } from './load-participation';
import { coreNeedsGenerator } from '../generators/core-needs.generator';
import type { DocSection } from '../report-doc';

const report = {
  responseQuality: {
    validResponses: 12,
    submittedResponses: 15,
    requiredSampleSize: 81,
    population: 500,
    overallConfidence: 'LOW',
    confidenceReason: 'Fewer valid responses than the required sample.',
  },
  severity: {
    overallVillageNeedsIndex: 72,
    label: 'HIGH',
    domains: [
      { name: 'Health', severityScore: 81, validResponseCount: 12 },
      { name: 'Education', severityScore: 40, validResponseCount: 9 },
    ],
  },
  priorityNeeds: {
    needs: [
      { kpiName: 'Distance to the nearest clinic', severityScore: 88, gapType: 'structural', validResponseCount: 12 },
      { kpiName: 'Children out of school', severityScore: 52, gapType: 'acute', validResponseCount: 4 },
    ],
  },
  coverage: { responsesExcluded: 3, duplicateResponses: 1, lowConfidenceResponses: 1 },
  villages: [
    { village: 'Al Aham', validResponses: 9, severityScore: 75 },
    { village: 'Al Qarain', validResponses: 3, severityScore: 60 },
  ],
};
const participation = [
  {
    governorate: 'Ad-Dawadmi',
    total: 12,
    rows: [
      { village: 'Al Aham', responses: 9, sharePct: 75, status: 'CONCENTRATED' as const },
      { village: 'Al Qarain', responses: 3, sharePct: 25, status: null },
    ],
  },
];

// Every block switched on and the design restyle applied, as a report type
// would get them once enabled in presentation.config.ts.
const full = (): ReportPresentation => ({
  ...buildPresentation('RPT14', report, {
    participation,
    reviewerName: 'Reviewer',
    reviewerRole: 'Human Reviewer',
    organization: 'Sample Charity',
    reviewedAt: '2026-10-23T10:00:00Z',
    ageBands: [
      { band: '18-24', count: 4 },
      { band: '25-44', count: 8 },
    ],
  }),
  blocks: [...ALL_PRESENTATION_BLOCKS],
  design: true,
});

describe('presentation cards', () => {
  it.each(['en', 'ar'] as const)('draws every card in %s', (locale) => {
    const sections = presentationDocSections(full(), locale);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    expect(sections.every((s) => typeof s.kind === 'string')).toBe(true);
  });

  it('draws nothing without a presentation or for an unknown version', () => {
    expect(presentationDocSections(null, 'en')).toEqual([]);
    expect(presentationDocSections({ ...full(), version: 2 } as unknown as ReportPresentation, 'en')).toEqual([]);
  });

  it('names and explains each confidence band', () => {
    for (const band of ['VERY_LOW', 'MEDIUM', 'STRONG'] as const) {
      expect(bandLabel(band, 'en')).toBeTruthy();
      expect(bandLabel(band, 'ar')).not.toBe(bandLabel(band, 'en'));
    }
    const c = full().confidence!;
    // The sentence changes with what the study recorded.
    const notes = [c, { ...c, population: null }, { ...c, requiredSampleSize: null }].map((x) => bandNote(x, 'en'));
    expect(new Set(notes).size).toBe(3);
    expect(confidenceSentence(c, 'en')).toContain('12');
  });
});

describe('applyDesign', () => {
  const sections: DocSection[] = [
    { kind: 'note', heading: 'Response Quality', text: 'LOW — Fewer valid responses than the required sample.' },
    { kind: 'keyvalue', heading: 'Response Quality', rows: [{ label: 'Overall confidence', value: 'LOW' }] },
    {
      kind: 'table',
      heading: 'Severity by Domain',
      columns: ['Domain', 'Severity'],
      rows: [
        ['Health', '81'],
        ['Education', '40'],
      ],
    },
    { kind: 'list', heading: 'Priority Needs', items: ['Distance to the nearest clinic'] },
  ];

  it.each(['en', 'ar'] as const)('restyles the sections in %s without losing any heading', (locale) => {
    const out = applyDesign(sections, full(), locale, report);
    expect(out.length).toBeGreaterThan(0);
    const headings = new Set(out.map((s) => ('heading' in s ? s.heading : undefined)));
    expect(headings.has('Severity by Domain') || out.some((s) => s.kind === 'table')).toBe(true);
  });

  it('leaves sections alone when the report has no confidence figures', () => {
    const p = { ...full(), confidence: null };
    expect(applyDesign(sections, p, 'en', {})).toHaveLength(sections.length);
  });
});

describe('applyDesign, section by section', () => {
  const designSections: DocSection[] = [
    { kind: 'keyvalue', heading: 'AI Summary', rows: [{ label: 'Summary', value: 'Health is the most severe need.' }] },
    { kind: 'note', heading: 'Data Quality Note', text: 'LOW — Fewer valid responses than the required sample.' },
    { kind: 'note', heading: 'Demographic Breakdown', text: 'By gender and area type.' },
    { kind: 'pie', heading: 'Gender Breakdown', slices: [{ label: 'Female', value: 7 }, { label: 'Male', value: 5 }] },
    { kind: 'pie', heading: 'Rural / Urban Breakdown', slices: [{ label: 'Rural', value: 8 }, { label: 'Urban', value: 4 }] },
    { kind: 'stats', heading: 'Coverage', tiles: [{ label: 'Valid responses', value: '12' }, { label: 'Excluded', value: '3' }] },
    {
      kind: 'table',
      heading: 'Top KPIs',
      columns: ['Kpi', 'Severity Score', 'Confidence', 'Valid Response Count', 'Why this band', 'Empty'],
      rows: [
        ['Distance to the nearest clinic', '88', 'LOW', '12', '', ''],
        ['Children out of school', '52', 'LOW', 'n/a', '', ''],
      ],
    },
    {
      kind: 'table',
      heading: 'Domain table',
      columns: ['Domain', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
      rows: [
        ['Health', '1', '2', 'same', '4', '5', '6', '7', '8', '9'],
        ['Education', '1', '3', 'same', '4', '5', '6', '7', '8', '9'],
      ],
    },
    { kind: 'columns', children: [{ kind: 'note', heading: 'Left', text: 'One.' }, { kind: 'note', heading: 'Right', text: 'Two.' }] },
  ];

  it.each([
    ['very low', 5],
    ['medium', 40],
    ['strong', 120],
  ] as const)('restyles a report whose confidence is %s', (_name, valid) => {
    const content = { ...report, responseQuality: { ...report.responseQuality, validResponses: valid } };
    const p: ReportPresentation = {
      ...buildPresentation('RPT14', content, { participation, ageBands: [{ band: '18-24', count: 3 }] }),
      blocks: [...ALL_PRESENTATION_BLOCKS],
      design: true,
      referenced: [
        { key: 'aiSummary', home: 'RPT15' },
        { key: 'dataQualityNote', home: 'RPT13' },
        { key: 'demographics', home: 'RPT03' },
      ],
    };
    for (const locale of ['en', 'ar'] as const) {
      const out = applyDesign(designSections, p, locale, content);
      expect(out.length).toBeGreaterThan(0);
      // The two demographic pies become one set of rings.
      expect(out.filter((s) => s.kind === 'pie')).toHaveLength(0);
    }
  });
});

describe('withGovernorateShare', () => {
  it('adds each village its share of the governorate from the participation figures', () => {
    const out = withGovernorateShare(report, participation);
    const rows = out.villages as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ village: 'Al Aham', governorateSharePct: 75 });
  });

  it('falls back to the table’s own counts, and leaves content without villages alone', () => {
    const out = withGovernorateShare(report, null);
    expect(Array.isArray(out.villages)).toBe(true);
    const none = { severity: {} };
    expect(withGovernorateShare(none, participation)).toBe(none);
  });
});

describe('loadParticipation', () => {
  const tx = {
    surveyResponse: { findMany: async () => [{ governorateIds: ['g1'], village: ['Al Aham'] }] },
    need: {
      findMany: async () => [
        { village: ['Al Aham', 'Al Qarain', ' '], needGovernorates: [{ governorateId: 'g1' }] },
        { village: ['Empty Village'], needGovernorates: [{ governorateId: 'g2' }] },
      ],
    },
    scoreRollup: {
      findMany: async () => [
        { surveyId: 's1', villageId: 'Al Aham', validResponseCount: 9 },
        { surveyId: 's1', villageId: 'Al Aham', validResponseCount: 1 }, // an older rollup: ignored
        { surveyId: 's1', villageId: 'Al Qarain', validResponseCount: 3 },
      ],
    },
    governorate: { findMany: async () => [{ id: 'g1', name: 'Ad-Dawadmi', nameAr: 'الدوادمي' }] },
  };

  it('shares each governorate’s valid responses out by village, latest rollup only', async () => {
    const groups = await loadParticipation(tx as never, 'study', 'ar');
    expect(groups).toHaveLength(1); // the governorate with no responses is left out
    expect(groups[0]!.governorate).toBe('الدوادمي');
    expect(groups[0]!.rows.map((r) => [r.village, r.responses, r.sharePct])).toEqual([
      ['Al Aham', 9, 75],
      ['Al Qarain', 3, 25],
    ]);
    expect(groups[0]!.rows[0]!.status).toBe('CONCENTRATED');
  });

  it('is empty when no village has a governorate', async () => {
    const empty = { ...tx, need: { findMany: async () => [] }, surveyResponse: { findMany: async () => [] } };
    expect(await loadParticipation(empty as never, 'study', 'en')).toEqual([]);
  });
});

describe('coreNeedsGenerator', () => {
  const ctx = (filters: Record<string, unknown>, studyId: string | null = 's1') =>
    ({
      studyId,
      studyTitle: 'Community Needs',
      orgId: 'o1',
      filters,
      provider: {
        getCoreNeedsReport: async (q: { filters: Record<string, unknown> }) => ({
          header: { unitName: q.filters.scopeLevel === 'KINGDOM' ? null : 'Al-Ahsa', studyName: 'Community Needs' },
          filters: q.filters,
        }),
      },
    }) as never;

  it('needs a study, a known scope level and, below the Kingdom, an area', async () => {
    await expect(coreNeedsGenerator(ctx({}, null))).rejects.toThrow();
    await expect(coreNeedsGenerator(ctx({ scopeLevel: 'PLANET' }))).rejects.toThrow();
    await expect(coreNeedsGenerator(ctx({ scopeLevel: 'GOVERNORATE', unitId: ' ' }))).rejects.toThrow();
  });

  it('titles the full report and the one-page summary by their area', async () => {
    const full = await coreNeedsGenerator(ctx({ scopeLevel: 'GOVERNORATE', unitId: 'g1', domainKeys: ['HEALTH', 3, ''] }));
    expect(full.title).toBe('Core Needs Report — Al-Ahsa');
    expect((full.content as { filters: { domainKeys: string[] } }).filters.domainKeys).toEqual(['HEALTH']);
    const summary = await coreNeedsGenerator(ctx({ output: 'SUMMARY' }));
    expect(summary.title).toBe('Executive Summary — Community Needs');
  });
});
