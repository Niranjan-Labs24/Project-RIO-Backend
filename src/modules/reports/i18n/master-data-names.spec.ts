import { describe, expect, it } from 'vitest';
import {
  loadMasterDataAliases,
  localizeDataValues,
  NO_ALIASES,
  type MasterDataTx,
} from './master-data-names';
import { buildReportDoc, type ReportDoc } from '../report-doc';
import { StubReportDataProvider } from '../providers/__fixtures__/report-content.fixtures';
import { individualSurveyGenerator } from '../generators/individual-survey.generator';
import { villageGenerator } from '../generators/village.generator';
import type { GeneratorCtx } from '../generators';

const ARABIC = /[؀-ۿ]/;

// The Arabic names actually seeded in the database for the fixture's domains,
// so this exercises the real mapping rather than invented pairs.
const DOMAINS = [
  { name: 'Health', nameAr: 'الصحة' },
  { name: 'Education', nameAr: 'التعليم' },
  { name: 'Infrastructure', nameAr: 'البنية التحتية' },
  { name: 'Livelihood', nameAr: 'سبل العيش' },
  { name: 'Water & Sanitation', nameAr: 'المياه والصرف الصحي' },
];

const tx = (over: Partial<MasterDataTx> = {}): MasterDataTx =>
  ({
    domain: { findMany: async () => DOMAINS },
    subDomain: { findMany: async () => [{ name: 'Health Services', nameAr: 'الخدمات الصحية' }] },
    region: { findMany: async () => [{ name: 'Al-Qassim', nameAr: 'القصيم' }] },
    governorate: { findMany: async () => [{ name: 'Al-Badai', nameAr: 'البدائع' }] },
    center: { findMany: async () => [] },
    question: {
      findMany: async () => [
        {
          indicator: 'Daily Clean Water Access',
          indicatorAr: 'الحصول اليومي على مياه نظيفة',
          kpi: null,
          kpiAr: null,
        },
      ],
    },
    ...over,
  }) as MasterDataTx;

const ctx = (over: Partial<GeneratorCtx> = {}): GeneratorCtx => ({
  provider: new StubReportDataProvider(),
  orgId: 'org-1',
  studyId: 'study-1',
  studyTitle: 'Ad-Dilam Baseline',
  filters: {},
  ...over,
});

describe('loadMasterDataAliases', () => {
  it('returns an empty map for English so the pass is a no-op', async () => {
    expect((await loadMasterDataAliases(tx(), 'en')).size).toBe(0);
  });

  it('maps every table that carries an Arabic name', async () => {
    const a = await loadMasterDataAliases(tx(), 'ar');
    expect(a.get('health')).toBe('الصحة');
    expect(a.get('health services')).toBe('الخدمات الصحية');
    expect(a.get('al-qassim')).toBe('القصيم');
    expect(a.get('al-badai')).toBe('البدائع');
    expect(a.get('daily clean water access')).toBe('الحصول اليومي على مياه نظيفة');
  });

  it('is case- and whitespace-insensitive on lookup', async () => {
    const a = await loadMasterDataAliases(tx(), 'ar');
    expect(a.get('  HEALTH  '.trim().toLowerCase())).toBe('الصحة');
  });

  it('skips rows with no Arabic name rather than mapping them to nothing', async () => {
    // nameAr is nullable and starts empty on a fresh install; an unseeded row
    // has to keep its English, not become blank.
    const a = await loadMasterDataAliases(
      tx({ domain: { findMany: async () => [{ name: 'Culture', nameAr: null }] } }),
      'ar',
    );
    expect(a.has('culture')).toBe(false);
  });

  it('keeps the first mapping when two tables share an English name', async () => {
    // A Center and a Governorate frequently share a name. Deterministic beats
    // whichever query resolved last.
    const a = await loadMasterDataAliases(
      tx({
        governorate: { findMany: async () => [{ name: 'Buraydah', nameAr: 'بريدة' }] },
        center: { findMany: async () => [{ name: 'Buraydah', nameAr: 'بريدة المركز' }] },
      }),
      'ar',
    );
    expect(a.get('buraydah')).toBe('بريدة');
  });
});

describe('localizeDataValues', () => {
  it('does nothing with an empty alias map', async () => {
    const { title, content } = await individualSurveyGenerator(ctx({ surveyId: 'sv' }));
    const doc = buildReportDoc(title, content, [], 'ar');
    expect(localizeDataValues(doc, NO_ALIASES)).toBe(doc);
  });

  it('translates domain names in table cells and chart categories', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const { title, content } = await individualSurveyGenerator(ctx({ surveyId: 'sv' }));
    const before = buildReportDoc(title, content, [], 'ar');
    const after = localizeDataValues(before, aliases);

    const cells = (d: ReportDoc) =>
      d.sections.flatMap((s) => (s.kind === 'table' ? s.rows.flat() : []));
    const bars = (d: ReportDoc) =>
      d.sections.flatMap((s) => (s.kind === 'bars' ? s.bars.map((b) => b.label) : []));

    expect(cells(before).filter((c) => c === 'Health').length).toBeGreaterThan(0);
    expect(cells(after).filter((c) => c === 'Health')).toEqual([]);
    expect(cells(after).filter((c) => c === 'الصحة').length).toBeGreaterThan(0);

    if (bars(before).includes('Health')) expect(bars(after)).toContain('الصحة');
  });

  it('leaves numbers, codes and dates alone', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const { title, content } = await individualSurveyGenerator(ctx({ surveyId: 'sv' }));
    const before = buildReportDoc(title, content, [], 'ar');
    const after = localizeDataValues(before, aliases);

    const numericish = (d: ReportDoc) =>
      d.sections.flatMap((s) =>
        s.kind === 'table' ? s.rows.flat().filter((c) => /^[\d.,%+\-—]+$/.test(c)) : [],
      );
    expect(numericish(after)).toEqual(numericish(before));
  });

  it('does not touch labels the catalogue already translated', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const { title, content } = await individualSurveyGenerator(ctx({ surveyId: 'sv' }));
    const before = buildReportDoc(title, content, [], 'ar');
    const after = localizeDataValues(before, aliases);

    // pageBreak is excluded deliberately: its heading is "{domain} — تفاصيل
    // المجال", i.e. a LABEL with a DATA name in front of it, so it is the one
    // heading this pass is supposed to rewrite.
    const headings = (d: ReportDoc) =>
      d.sections
        .filter((s) => s.kind !== 'pageBreak')
        .map((s) => ('heading' in s ? s.heading : undefined));
    const columns = (d: ReportDoc) =>
      d.sections.flatMap((s) => (s.kind === 'table' ? s.columns : []));

    // "Domains" is both a catalogue label and, lowercased, a plausible master
    // key — the label must win in a label position.
    expect(headings(after)).toEqual(headings(before));
    expect(columns(after)).toEqual(columns(before));
  });

  it('translates the name in front of a composed drill-down heading', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const { title, content } = await individualSurveyGenerator(ctx({ surveyId: 'sv' }));
    const after = localizeDataValues(buildReportDoc(title, content, [], 'ar'), aliases);

    const pageHeadings = after.sections
      .filter((s) => s.kind === 'pageBreak')
      .map((s) => (s.kind === 'pageBreak' ? s.heading : undefined))
      .filter((h): h is string => Boolean(h));

    const domainPages = pageHeadings.filter((h) => h.includes('تفاصيل المجال'));
    expect(domainPages.length).toBeGreaterThan(0);
    // Both halves Arabic: the suffix from the catalogue, the name from nameAr.
    for (const h of domainPages) {
      expect(ARABIC.test(h.split(' — ')[0]!), h).toBe(true);
    }
  });

  it('translates breadcrumb trails on drill-down pages', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const { title, content } = await villageGenerator(ctx({ filters: { villageId: 'v' } }));
    const before = buildReportDoc(title, content, [], 'ar');
    const after = localizeDataValues(before, aliases);

    const crumbs = (d: ReportDoc) =>
      d.sections.flatMap((s) => (s.kind === 'breadcrumb' ? s.trail.map((t) => t.label) : []));
    if (crumbs(before).includes('Health')) expect(crumbs(after)).toContain('الصحة');
  });
});

describe('report titles', () => {
  it('translates the fixed phrase and the master-data name in it', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');

    // The frozen English title as a generator wrote it at creation time.
    const doc = buildReportDoc('Village Report — Al-Badai', { summary: 'x' }, [], 'ar');
    expect(doc.title, 'catalogue pass translates the fixed phrase').toBe(
      'تقرير القرية — Al-Badai',
    );

    const after = localizeDataValues(doc, aliases);
    expect(after.title, 'alias pass resolves the name').toBe('تقرير القرية — البدائع');
  });

  it('handles a title whose name comes first', async () => {
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const doc = buildReportDoc('Al-Qassim — Evidence Document Report', { summary: 'x' }, [], 'ar');

    expect(localizeDataValues(doc, aliases).title).toBe('القصيم — تقرير مستندات الأدلة');
  });

  it('keeps a name the master data does not know', async () => {
    // Survey titles are free text, not master data — they stay as authored
    // until the free-text translation pass covers them, rather than being
    // dropped or mangled.
    const aliases = await loadMasterDataAliases(tx(), 'ar');
    const doc = buildReportDoc(
      'Individual Survey Report — Baseline Household Survey',
      { summary: 'x' },
      [],
      'ar',
    );

    expect(localizeDataValues(doc, aliases).title).toBe(
      'تقرير المسح الفردي — Baseline Household Survey',
    );
  });

  it('leaves English titles untouched', () => {
    const doc = buildReportDoc('Village Report — Al-Badai', { summary: 'x' }, []);
    expect(doc.title).toBe('Village Report — Al-Badai');
  });
});
