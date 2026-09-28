import { describe, expect, it, vi } from 'vitest';
import {
  localizeNcnpReportNames,
  mapNcnpFreeText,
  type NcnpArabicNames,
} from './ncnp-report-localize';
import { splitBilingual } from './ncnp-report-pdf';

describe('mapNcnpFreeText', () => {
  const report = {
    orgs: [{ organizationName: 'Hope Foundation' }, { organizationName: 'Hope Foundation' }],
    needs: [{ needTitle: 'Water access', indicatorId: 'WAS-01', count: 3 }],
    untouched: { name: 'Riyadh' },
  };

  it('maps only free-text fields, deduplicates lookups, and leaves everything else alone', async () => {
    const fn = vi.fn(async (text: string, key: string) => `${key}:${text}`);
    const out = await mapNcnpFreeText(report, fn);
    expect(out.orgs.map((o) => o.organizationName)).toEqual([
      'organizationName:Hope Foundation',
      'organizationName:Hope Foundation',
    ]);
    expect(out.needs[0]).toEqual({
      needTitle: 'needTitle:Water access',
      indicatorId: 'indicatorId:WAS-01',
      count: 3,
    });
    expect(out.untouched).toEqual({ name: 'Riyadh' });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(report.orgs[0]!.organizationName).toBe('Hope Foundation');
  });

  it('keeps the original text when a lookup fails instead of failing the export', async () => {
    const out = await mapNcnpFreeText(report, async (text) => {
      if (text === 'Water access') throw new Error('provider down');
      return text.toUpperCase();
    });
    expect(out.needs[0]!.needTitle).toBe('Water access');
    expect(out.needs[0]!.indicatorId).toBe('WAS-01');
    expect(out.orgs[0]!.organizationName).toBe('HOPE FOUNDATION');
  });
});

describe('localizeNcnpReportNames — primary gap', () => {
  const names: NcnpArabicNames = {
    domains: new Map([['Water & Sanitation', 'المياه والصرف الصحي']]),
    subDomains: new Map(),
    geography: new Map([['Riyadh', 'الرياض']]),
    gapTypes: new Map([['acute', 'حاد']]),
  };
  const need = (primaryGap: string | null) => ({
    domain: null,
    subDomain: null,
    primaryGap,
    unitGeoRegion: 'Riyadh',
  });
  const base: any = {
    needDomains: [],
    needSubDomains: [],
    needsGeography: { byRegion: [], byGovernorate: [], byCenter: [] },
    geography: {
      organizationsByRegion: [],
      organizationsByGovernorate: [],
      organizationsByCenter: [],
      studiesByRegion: [],
    },
    surveyGeography: { byRegion: [], byGovernorate: [], byCenter: [] },
    surveyAnalytics: { statusByRegion: [] },
    regionSummary: [],
    responseAnalytics: { responsesByRegion: [] },
    priorityOverview: { domainComparison: [] },
    domainRegionIntersections: [],
    criticalNeeds: { topCriticalNeeds: [], priorityNeeds: [] },
  };

  it('translates a gap type, falls back to a domain name, and keeps unknown or empty gaps', () => {
    const report = {
      ...base,
      criticalNeeds: {
        topCriticalNeeds: [],
        priorityNeeds: [need('acute'), need('Water & Sanitation'), need('Other'), need(null)],
      },
    };
    const out = localizeNcnpReportNames(report, names);
    expect(out.criticalNeeds.priorityNeeds.map((n) => n.primaryGap)).toEqual([
      'حاد',
      'المياه والصرف الصحي',
      'Other',
      null,
    ]);
    expect(out.criticalNeeds.priorityNeeds[0]!.unitGeoRegion).toBe('الرياض');
  });
});

describe('splitBilingual', () => {
  it('splits "Primary (Other language)" so each name can sit on its own line', () => {
    expect(splitBilingual('مؤسسة الأمل (Hope Foundation)')).toEqual({
      primary: 'مؤسسة الأمل',
      secondary: 'Hope Foundation',
    });
    expect(splitBilingual('Hope Foundation (مؤسسة الأمل)')).toEqual({
      primary: 'Hope Foundation',
      secondary: 'مؤسسة الأمل',
    });
  });

  it('does not split a single-language name or one without a parenthesised counterpart', () => {
    expect(splitBilingual('Hope Foundation')).toEqual({
      primary: 'Hope Foundation',
      secondary: null,
    });
    expect(splitBilingual('Hope (Riyadh)')).toEqual({ primary: 'Hope (Riyadh)', secondary: null });
  });

  it('handles a nested bracket in the second name and long unbroken input without slowing down', () => {
    expect(splitBilingual('مؤسسة الأمل (Hope Foundation (Makkah))')).toEqual({ primary: 'مؤسسة الأمل', secondary: 'Hope Foundation (Makkah)' });
    const long = `${'a '.repeat(50_000)}(b`;
    const started = Date.now();
    expect(splitBilingual(long)).toEqual({ primary: long, secondary: null });
    expect(splitBilingual(`${'ع '.repeat(50_000)}عربي (y)`).secondary).toBe('y');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
