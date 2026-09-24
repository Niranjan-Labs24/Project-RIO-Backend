import { describe, expect, it } from 'vitest';
import { renderNcnpReportPdf } from './ncnp-report-pdf';
import { localizeNcnpReportNames } from './ncnp-report-localize';
import { NCNP_PDF_AR } from './ncnp-report-pdf-labels';

const st = (c: number, p = 0) => ({ current: c, previous: p, changePct: p ? ((c - p) / p) * 100 : null });
const nb = (n: string, code: string, c: number) => ({ id: 'i' + code, code, name: n, count: c });
const regions = [nb('Riyadh', '1', 12), nb('Makkah', '2', 7), nb('Eastern Province', '5', 3), nb('Tabuk', '7', 0)];
const surv = { draft: 3, submitted: 2, published: 9, rejected: 1 };
const need = (i: number) => ({ needId: 'n' + i, needTitle: 'احتياجات المياه والصحة ' + i, domain: 'Water & Sanitation', subDomain: 'Drinking Water Access', organizationName: 'جمعية الإبداع الرياضي', priorityScore: 37.5, priorityStatus: 'HIGH', primaryGap: 'acute', evidenceCount: 2, source: 'manual_entry', equityFlag: true, indicatorId: 'WAS-01', unitGeoRegion: 'Riyadh', sourceRef: 'REF-1' });
const row = (n: string, k: number) => ({ organizationId: n, organizationName: n, studyCount: k, surveyCount: k + 1, responseCount: k * 10, isActive: true });
const report: any = {
  generatedAt: new Date().toISOString(),
  summary: { totals: { organizations: 20, studies: 30, surveys: 15, responses: 260, needs: 55 }, newThisPeriod: { periodDays: 30, organizations: st(3, 2), studies: st(4), surveys: st(2, 1), responses: st(50, 40) } },
  orgHealth: { active: 15, inactive: 5, dormant: 2, dormantDays: 60, needsAttention: [{ organizationId: 'a', organizationName: 'جمعية الإبداع الرياضي', lastActivity: null }] },
  orgSummary: { byStudies: [row('Org A', 4), row('Org B', 3)], bySurveys: [row('Org A', 4)], byResponses: [row('Org A', 4)], totalOrganizations: 20 },
  needDomains: [{ domainCode: 'W', domainName: 'Water & Sanitation', needCount: 20 }, { domainCode: 'H', domainName: 'Health', needCount: 10 }],
  needSubDomains: [{ domainName: 'Health', subDomainName: 'Maternal & Child Health', needCount: 4 }],
  needsGeography: { byRegion: regions, byGovernorate: regions, byCenter: regions },
  studyStatus: { active: 25, archived: 5 }, publicLinkStatus: { open: 4, closed: 2 },
  studyOverview: { topOrgsByStudyCount: [{ organizationId: 'a', organizationName: 'Org A', studyCount: 4 }], totalOrganizations: 20, studiesCreatedTrend: [{ month: '2026-08', count: 3 }, { month: '2026-09', count: 5 }] },
  geography: { organizationsByRegion: regions, organizationsByGovernorate: regions, organizationsByCenter: regions, studiesByRegion: regions },
  surveyAnalytics: { statusPlatformWide: surv, statusByRegion: [{ regionId: 'r', regionName: 'Riyadh', count: 3, status: surv }], avgResponsesPerPublishedSurvey: 17.3, rejectionReasonBreakdown: [{ reasonCode: 'REJ_01', count: 2 }] },
  surveyGeography: { byRegion: regions, byGovernorate: regions, byCenter: regions },
  regionSummary: [{ regionId: 'r', regionName: 'Riyadh', surveyCount: 3, responseCount: 40, avgResponsesPerSurvey: 13.3 }],
  responseAnalytics: { monthlyTrend: [{ month: '2026-08', count: 20 }, { month: '2026-09', count: 30 }], responsesByRegion: [{ regionId: 'r', regionName: 'Riyadh', count: 40 }], genderDistribution: [{ gender: 'male', count: 10 }, { gender: 'female', count: 12 }], ageBracketDistribution: [{ ageBracket: 'age_15_24', count: 5 }], hasResponsesWithoutAgeBracket: true, topOrgsByTotalResponses: [{ organizationId: 'a', organizationName: 'Org A', value: 100 }], topOrgsByAvgResponsesPerSurvey: [{ organizationId: 'a', organizationName: 'Org A', value: 12.5 }] },
  priorityOverview: { byStatus: [{ status: 'HIGH', count: 3 }, { status: 'MEDIUM', count: 2 }], domainComparison: [{ domainKey: 'W', domainName: 'Water & Sanitation', avgPerformanceScore: 40, isCriticalDomain: false, assessmentCount: 3 }], topPriorityVillages: [{ studyId: 's', surveyId: 'v', villageId: 'Al Noor', priorityScore: 55, priorityStatus: 'HIGH' }] },
  criticalNeeds: { topCriticalNeeds: [need(1), need(2)], priorityNeeds: [need(1), need(2), need(3)], totalRankableNeeds: 9, totalNeeds: 55 },
  dataQualityNotes: { totalResponses: 260, assessedResponses: 200, lowConfidenceCount: 1, duplicateFlaggedCount: 0, totalNeeds: 55, needsWithEvidence: 30, needsWithoutEvidence: 25, needsUnclassified: 4 },
  domainRegionIntersections: [{ regionName: 'Riyadh', domainName: 'Water & Sanitation', needCount: 9 }],
};

describe('NCNP PDF — Arabic export', () => {
  it('renders both locales to a valid PDF, Arabic differing from English', () => {
    const en = renderNcnpReportPdf(report, 'Aparna', undefined, 'en');
    const ar = renderNcnpReportPdf(report, 'Aparna', undefined, 'ar');
    expect(en.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(ar.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(ar.equals(en)).toBe(false);
  });
  it('leaves the module locale untouched after an Arabic render (no bleed into the next English export)', () => {
    const before = renderNcnpReportPdf(report, 'Aparna', undefined, 'en');
    renderNcnpReportPdf(report, 'Aparna', undefined, 'ar');
    expect(renderNcnpReportPdf(report, 'Aparna', undefined, 'en').length).toBe(before.length);
  });
  it('has an Arabic string for every heading it translates', () => {
    for (const key of ['Key Metrics', 'Priority Needs', 'Data Quality Notes', 'Audit Trail']) expect(NCNP_PDF_AR[key]).toBeTruthy();
  });
  it('swaps master-data names for their Arabic ones and passes unknown ones through', () => {
    const out = localizeNcnpReportNames(report, {
      domains: new Map([['Water & Sanitation', 'المياه والصرف الصحي']]),
      subDomains: new Map(), geography: new Map([['Riyadh', 'الرياض']]), gapTypes: new Map([['acute', 'حاد']]),
    });
    expect(out.needDomains[0]!.domainName).toBe('المياه والصرف الصحي');
    expect(out.needDomains[1]!.domainName).toBe('Health');
    expect(out.geography.organizationsByRegion[0]!.name).toBe('الرياض');
    expect(out.criticalNeeds.priorityNeeds[0]!.primaryGap).toBe('حاد');
    expect(report.needDomains[0].domainName).toBe('Water & Sanitation');
  });
});
