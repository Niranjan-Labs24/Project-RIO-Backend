import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { NcnpReportService } from './ncnp-report.service';
import { orgContext } from '../../tenancy/org-context';

// Minimal local shapes — only the fields this file's fixtures actually set.
interface FakeOrg {
  id: string;
  name: string;
  isActive: boolean;
  updatedAt: Date;
  createdAt: Date;
  regionId?: string | null;
}
interface FakeStudy { id: string; orgId: string; status: string; createdAt: Date; updatedAt: Date }
interface FakeSurvey { id: string; orgId: string; needId?: string; status: string; createdAt: Date; rejectionReasonCode?: string | null }
interface FakeResponse { id: string; orgId: string; submittedAt: Date; regionId?: string | null; gender?: string | null; ageBracket?: string | null }
interface FakeDomain { code: string; name: string; isActive: boolean; displayOrder: number }
interface FakeNeedDomain { domain: string }
interface FakeRegion { id: string; name: string }
interface FakeGovernorate { id: string; name: string }
interface FakeCenter { id: string; name: string }
interface FakeOrgGovernorate { orgId: string; governorateId: string }
interface FakeOrgCenter { orgId: string; centerId: string }
interface FakeVillagePriorityAssessment {
  studyId: string;
  surveyId: string;
  villageId: string;
  priorityScore: number;
  priorityStatus: string;
  domainComponents: unknown;
  calculatedAt: Date;
}

interface FixtureOpts {
  organisations?: FakeOrg[];
  studies?: FakeStudy[];
  surveys?: FakeSurvey[];
  responses?: FakeResponse[];
  domains?: FakeDomain[];
  needDomains?: FakeNeedDomain[];
  regions?: FakeRegion[];
  priorityAssessments?: FakeVillagePriorityAssessment[];
  governorates?: FakeGovernorate[];
  centers?: FakeCenter[];
  orgGovernorates?: FakeOrgGovernorate[];
  orgCenters?: FakeOrgCenter[];
  // Survey geography is attributed via each survey's own Need's
  // governorates/centers, not the org's broader organisationGovernorate/
  // organisationCenter links (see ncnp-report.service's buildSurveyGeography
  // comment for why — the org-level join fanned a single survey out across
  // every governorate the org served, not just the ones its own Need
  // selected).
  needGovernorates?: Array<{ needId: string; governorateId: string }>;
  needCenters?: Array<{ needId: string; centerId: string }>;
  publicSurveyLinks?: Array<{ isActive: boolean }>;
  // rejectSurvey's audit trail — one row per rejection *event*, independent
  // of the survey's current status (see ncnp-report.service's
  // rejectionAuditRows query/comment for why this replaced a groupBy on
  // Survey.rejectionReasonCode).
  rejectionAuditRows?: Array<{ reasonCode: string | null }>;
}

function groupCount<T, K extends keyof T>(rows: T[], key: K): Array<{ [P in K]: T[K] } & { _count: number }> {
  const map = new Map<T[K], number>();
  for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
  return Array.from(map.entries()).map(([value, count]) => ({ [key]: value, _count: count }) as never);
}

function groupCountByTwo(
  rows: object[],
  keyA: string,
  keyB: string,
): Array<{ [k: string]: unknown }> {
  const map = new Map<string, { a: unknown; b: unknown; count: number }>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const a = row[keyA];
    const b = row[keyB];
    const mapKey = `${String(a)}::${String(b)}`;
    const existing = map.get(mapKey) ?? { a, b, count: 0 };
    existing.count += 1;
    map.set(mapKey, existing);
  }
  return Array.from(map.values()).map(({ a, b, count }) => ({ [keyA]: a, [keyB]: b, _count: count }));
}

function groupMax(rows: object[], groupKey: string, maxKey: string): Array<{ [k: string]: unknown }> {
  const map = new Map<unknown, Date>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const g = row[groupKey];
    const m = row[maxKey] as Date;
    const existing = map.get(g);
    if (!existing || m > existing) map.set(g, m);
  }
  return Array.from(map.entries()).map(([g, m]) => ({ [groupKey]: g, _max: { [maxKey]: m } }));
}

function fakeTenant(opts: FixtureOpts) {
  const organisations = opts.organisations ?? [];
  const studies = opts.studies ?? [];
  const surveys = opts.surveys ?? [];
  const responses = opts.responses ?? [];
  const domains = opts.domains ?? [{ code: 'H', name: 'Health', isActive: true, displayOrder: 1 }];
  const needDomains = opts.needDomains ?? [];
  const regions = opts.regions ?? [];
  const priorityAssessments = opts.priorityAssessments ?? [];
  const governorates = opts.governorates ?? [];
  const centers = opts.centers ?? [];
  const orgGovernorates = opts.orgGovernorates ?? [];
  const orgCenters = opts.orgCenters ?? [];
  const needGovernorates = opts.needGovernorates ?? [];
  const needCenters = opts.needCenters ?? [];
  const publicSurveyLinks = opts.publicSurveyLinks ?? [];
  const rejectionAuditRows = opts.rejectionAuditRows ?? [];

  const inRange = (d: Date, gte?: Date, lt?: Date) => (!gte || d >= gte) && (!lt || d < lt);

  return {
    async runAsSupervisor<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        organisation: {
          findMany: async () => organisations,
          count: async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) => {
            const range = args?.where?.createdAt;
            return organisations.filter((o) => inRange(o.createdAt, range?.gte, range?.lt)).length;
          },
          groupBy: async () => groupCount(organisations, 'regionId'),
        },
        study: {
          count: async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) => {
            const range = args?.where?.createdAt;
            return studies.filter((s) => inRange(s.createdAt, range?.gte, range?.lt)).length;
          },
          findMany: async (args?: { where?: { createdAt?: { gte?: Date } } }) => {
            const gte = args?.where?.createdAt?.gte;
            return studies.filter((s) => !gte || s.createdAt >= gte).map((s) => ({ createdAt: s.createdAt }));
          },
          groupBy: async (args: { by: string[]; _max?: unknown }) => {
            if (args._max) return groupMax(studies, 'orgId', 'updatedAt');
            if (args.by[0] === 'status') return groupCount(studies, 'status');
            return groupCount(studies, 'orgId');
          },
        },
        survey: {
          count: async (args?: { where?: { createdAt?: { gte?: Date; lt?: Date } } }) => {
            const range = args?.where?.createdAt;
            return surveys.filter((s) => inRange(s.createdAt, range?.gte, range?.lt)).length;
          },
          findMany: async () => surveys.map((s) => ({ id: s.id, needId: s.needId ?? s.id })),
          groupBy: async (args: { by: string[]; where?: { status?: string }; _max?: unknown }) => {
            if (args._max) return groupMax(surveys, 'orgId', 'createdAt');
            const rows = args.where?.status ? surveys.filter((s) => s.status === args.where?.status) : surveys;
            if (args.by.length === 2) return groupCountByTwo(rows, 'orgId', 'status');
            if (args.by[0] === 'status') return groupCount(rows, 'status');
            return groupCount(rows, 'orgId');
          },
        },
        surveyResponse: {
          count: async (args?: { where?: { submittedAt?: { gte?: Date; lt?: Date } } }) => {
            const range = args?.where?.submittedAt;
            return responses.filter((r) => inRange(r.submittedAt, range?.gte, range?.lt)).length;
          },
          findMany: async (args?: { where?: { submittedAt?: { gte?: Date } } }) => {
            const gte = args?.where?.submittedAt?.gte;
            return responses.filter((r) => !gte || r.submittedAt >= gte).map((r) => ({ submittedAt: r.submittedAt }));
          },
          groupBy: async (args: { by: string[]; _max?: unknown }) => {
            if (args._max) return groupMax(responses, 'orgId', 'submittedAt');
            if (args.by[0] === 'regionId') return groupCount(responses, 'regionId');
            if (args.by[0] === 'gender') return groupCount(responses, 'gender');
            if (args.by[0] === 'ageBracket') return groupCount(responses, 'ageBracket');
            return groupCount(responses, 'orgId');
          },
        },
        domain: {
          findMany: async () => domains,
        },
        needDomain: {
          groupBy: async () => groupCount(needDomains, 'domain'),
        },
        publicSurveyLink: {
          groupBy: async () => groupCount(publicSurveyLinks, 'isActive'),
        },
        region: {
          findMany: async () => regions,
        },
        governorate: {
          findMany: async () => governorates,
        },
        organisationGovernorate: {
          groupBy: async () => groupCount(orgGovernorates, 'governorateId'),
          findMany: async () => orgGovernorates,
        },
        center: {
          findMany: async () => centers,
        },
        organisationCenter: {
          groupBy: async () => groupCount(orgCenters, 'centerId'),
          findMany: async () => orgCenters,
        },
        needGovernorate: {
          findMany: async () => needGovernorates,
        },
        needCenter: {
          findMany: async () => needCenters,
        },
        villagePriorityAssessment: {
          groupBy: async () => groupCount(priorityAssessments, 'priorityStatus'),
          findMany: async () =>
            [...priorityAssessments]
              .sort((a, b) => b.calculatedAt.getTime() - a.calculatedAt.getTime())
              .map(({ studyId, surveyId, villageId, priorityScore, priorityStatus, domainComponents }) => ({
                studyId,
                surveyId,
                villageId,
                priorityScore,
                priorityStatus,
                domainComponents,
              })),
        },
        user: {
          findUnique: async () => ({ name: 'Test Admin' }),
        },
        auditLog: {
          findMany: async () =>
            rejectionAuditRows.map((r) => ({
              metadata: { changes: [{ field: 'Rejection Reason', before: null, after: r.reasonCode }] },
            })),
        },
      };
      return fn(tx);
    },
  };
}

function runAs(role: string, fn: () => Promise<unknown>) {
  return orgContext.run({ requestId: 'r1', actorId: 'sys1', role }, fn);
}

describe('NcnpReportService', () => {
  it('rejects a non-cross-entity role', async () => {
    const service = new NcnpReportService(fakeTenant({}) as never);
    await expect(runAs('ngo_admin', () => service.getReport())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns platform totals and lists every active domain, including zero-need ones', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Org 1', isActive: true, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-07-01') },
        ],
        domains: [
          { code: 'H', name: 'Health', isActive: true, displayOrder: 1 },
          { code: 'E', name: 'Education', isActive: true, displayOrder: 2 },
        ],
        needDomains: [{ domain: 'Health' }, { domain: 'Health' }],
      }) as never,
    );

    const report = await runAs('system_admin', () => service.getReport());

    expect((report as { summary: { totals: { organizations: number } } }).summary.totals.organizations).toBe(1);
    const needDomains = (report as { needDomains: Array<{ domainName: string; needCount: number }> }).needDomains;
    expect(needDomains).toEqual([
      { domainCode: 'H', domainName: 'Health', needCount: 2 },
      { domainCode: 'E', domainName: 'Education', needCount: 0 },
    ]);
  });

  it('computes a null changePct when the previous period had zero, and a real one otherwise', async () => {
    const now = new Date();
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    const service = new NcnpReportService(
      fakeTenant({
        studies: [
          { id: 's1', orgId: 'o1', status: 'active', createdAt: twentyDaysAgo, updatedAt: twentyDaysAgo },
          { id: 's2', orgId: 'o1', status: 'active', createdAt: twentyDaysAgo, updatedAt: twentyDaysAgo },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      summary: { newThisPeriod: { studies: { current: number; previous: number; changePct: number | null } } };
    };

    expect(report.summary.newThisPeriod.studies.current).toBe(2);
    expect(report.summary.newThisPeriod.studies.previous).toBe(0);
    expect(report.summary.newThisPeriod.studies.changePct).toBeNull();
  });

  it('flags an org with no recent activity as dormant and needing attention', async () => {
    const staleDate = new Date('2020-01-01');
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'stale', name: 'Stale Org', isActive: true, createdAt: staleDate, updatedAt: staleDate },
          { id: 'fresh', name: 'Fresh Org', isActive: true, createdAt: staleDate, updatedAt: new Date() },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      orgHealth: { dormant: number; needsAttention: Array<{ organizationId: string }> };
    };

    expect(report.orgHealth.dormant).toBe(1);
    expect(report.orgHealth.needsAttention.map((o) => o.organizationId)).toEqual(['stale']);
  });

  it('does not count an inactive org as dormant (Active/Inactive and dormancy are separate axes)', async () => {
    const staleDate = new Date('2020-01-01');
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [{ id: 'o1', name: 'Inactive Org', isActive: false, createdAt: staleDate, updatedAt: staleDate }],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      orgHealth: { active: number; inactive: number; dormant: number };
    };

    expect(report.orgHealth.active).toBe(0);
    expect(report.orgHealth.inactive).toBe(1);
    expect(report.orgHealth.dormant).toBe(0);
  });

  it('breaks down survey status platform-wide and by region, excluding orgs with no region', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Org 1', isActive: true, createdAt: new Date(), updatedAt: new Date(), regionId: 'r1' },
          { id: 'o2', name: 'Org 2', isActive: true, createdAt: new Date(), updatedAt: new Date(), regionId: null },
        ],
        regions: [{ id: 'r1', name: 'Riyadh' }],
        surveys: [
          { id: 's1', orgId: 'o1', status: 'PUBLISHED', createdAt: new Date() },
          { id: 's2', orgId: 'o1', status: 'DRAFT', createdAt: new Date() },
          { id: 's3', orgId: 'o2', status: 'REJECTED', createdAt: new Date() },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      surveyAnalytics: {
        statusPlatformWide: { draft: number; published: number; rejected: number };
        statusByRegion: Array<{ regionName: string; count: number }>;
      };
    };

    expect(report.surveyAnalytics.statusPlatformWide).toEqual({ draft: 1, submitted: 0, published: 1, rejected: 1 });
    // Only o1 (Riyadh) contributes — o2 has no region and is excluded, not folded into an "Unknown" bucket.
    expect(report.surveyAnalytics.statusByRegion).toEqual([{ regionId: 'r1', regionName: 'Riyadh', count: 2, status: { draft: 1, submitted: 0, published: 1, rejected: 0 } }]);
  });

  it('computes avg responses per published survey platform-wide, and ranks top orgs by both total and average', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Big Org', isActive: true, createdAt: new Date(), updatedAt: new Date() },
          { id: 'o2', name: 'Small Org', isActive: true, createdAt: new Date(), updatedAt: new Date() },
        ],
        surveys: [
          { id: 's1', orgId: 'o1', status: 'PUBLISHED', createdAt: new Date() },
          { id: 's2', orgId: 'o2', status: 'PUBLISHED', createdAt: new Date() },
        ],
        responses: [
          { id: 'r1', orgId: 'o1', submittedAt: new Date() },
          { id: 'r2', orgId: 'o1', submittedAt: new Date() },
          { id: 'r3', orgId: 'o2', submittedAt: new Date() },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      surveyAnalytics: { avgResponsesPerPublishedSurvey: number };
      responseAnalytics: {
        topOrgsByTotalResponses: Array<{ organizationId: string; value: number }>;
        topOrgsByAvgResponsesPerSurvey: Array<{ organizationId: string; value: number }>;
      };
    };

    // 3 responses / 2 published surveys
    expect(report.surveyAnalytics.avgResponsesPerPublishedSurvey).toBeCloseTo(1.5);
    expect(report.responseAnalytics.topOrgsByTotalResponses[0]).toEqual({ organizationId: 'o1', organizationName: 'Big Org', value: 2 });
    // Both orgs have exactly 1 published survey, so avg = raw response count per org — o1 still ranks first.
    expect(report.responseAnalytics.topOrgsByAvgResponsesPerSurvey[0]).toEqual({ organizationId: 'o1', organizationName: 'Big Org', value: 2 });
  });

  it('buckets the response trend by month and reports real gender/region distributions', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        regions: [{ id: 'r1', name: 'Riyadh' }],
        responses: [
          { id: 'r1', orgId: 'o1', submittedAt: new Date('2026-06-05'), regionId: 'r1', gender: 'male' },
          { id: 'r2', orgId: 'o1', submittedAt: new Date('2026-06-20'), regionId: 'r1', gender: 'female' },
          { id: 'r3', orgId: 'o1', submittedAt: new Date('2026-07-01'), regionId: null, gender: null },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      responseAnalytics: {
        monthlyTrend: Array<{ month: string; count: number }>;
        responsesByRegion: Array<{ regionName: string; count: number }>;
        genderDistribution: Array<{ gender: string; count: number }>;
      };
    };

    expect(report.responseAnalytics.monthlyTrend).toEqual(
      expect.arrayContaining([
        { month: '2026-06', count: 2 },
        { month: '2026-07', count: 1 },
      ]),
    );
    // The null-region/null-gender response is excluded from both breakdowns, not folded into "Unknown".
    expect(report.responseAnalytics.responsesByRegion).toEqual([{ regionId: 'r1', regionName: 'Riyadh', count: 2 }]);
    expect(report.responseAnalytics.genderDistribution.map((g) => g.gender).sort()).toEqual(['female', 'male']);
  });

  it('reports real age-bracket distribution and discloses (never zero-fills) historical responses with no bracket', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        responses: [
          { id: 'r1', orgId: 'o1', submittedAt: new Date('2026-06-05'), ageBracket: 'age_25_34' },
          { id: 'r2', orgId: 'o1', submittedAt: new Date('2026-06-06'), ageBracket: 'age_25_34' },
          { id: 'r3', orgId: 'o1', submittedAt: new Date('2026-06-07'), ageBracket: null }, // pre-feature, no bracket
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      responseAnalytics: {
        ageBracketDistribution: Array<{ ageBracket: string; count: number }>;
        hasResponsesWithoutAgeBracket: boolean;
      };
    };

    expect(report.responseAnalytics.ageBracketDistribution).toEqual([{ ageBracket: 'age_25_34', count: 2 }]);
    expect(report.responseAnalytics.hasResponsesWithoutAgeBracket).toBe(true);
  });

  it('reports zero-fills nothing when every response has an age bracket', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        responses: [{ id: 'r1', orgId: 'o1', submittedAt: new Date('2026-06-05'), ageBracket: 'age_15_24' }],
      }) as never,
    );
    const report = (await runAs('system_admin', () => service.getReport())) as {
      responseAnalytics: { hasResponsesWithoutAgeBracket: boolean };
    };
    expect(report.responseAnalytics.hasResponsesWithoutAgeBracket).toBe(false);
  });

  it('breaks down rejected surveys by real reason code, bucketing legacy rows with no code under UNSPECIFIED', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        rejectionAuditRows: [
          { reasonCode: 'REJ_03' },
          { reasonCode: 'REJ_03' },
          { reasonCode: null }, // legacy — rejected before the reason-code feature existed
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      surveyAnalytics: { rejectionReasonBreakdown: Array<{ reasonCode: string; count: number }> };
    };

    expect(report.surveyAnalytics.rejectionReasonBreakdown).toEqual([
      { reasonCode: 'REJ_03', count: 2 },
      { reasonCode: 'UNSPECIFIED', count: 1 },
    ]);
  });

  it('counts a rejection event even for a survey later resubmitted and published — historical events, not current status', async () => {
    // Survey.rejectionReasonCode is cleared on resubmit, so this survey's
    // *current* row has no rejection info at all — only the audit trail
    // still remembers it was once rejected for REJ_06.
    const service = new NcnpReportService(
      fakeTenant({
        surveys: [
          { id: 'sv1', orgId: 'o1', status: 'PUBLISHED', createdAt: new Date('2026-06-01'), rejectionReasonCode: null },
        ],
        rejectionAuditRows: [{ reasonCode: 'REJ_06' }],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      surveyAnalytics: {
        statusPlatformWide: { rejected: number };
        rejectionReasonBreakdown: Array<{ reasonCode: string; count: number }>;
      };
    };

    expect(report.surveyAnalytics.statusPlatformWide.rejected).toBe(0);
    expect(report.surveyAnalytics.rejectionReasonBreakdown).toEqual([{ reasonCode: 'REJ_06', count: 1 }]);
  });

  it('aggregates priority status counts and domain comparison, excluding consolidated (villageId="") rows from the scorecard list', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        priorityAssessments: [
          {
            studyId: 'st1', surveyId: 'sv1', villageId: 'Village A', priorityScore: 25, priorityStatus: 'HIGH',
            calculatedAt: new Date('2026-07-01'),
            domainComponents: [{ domainKey: 'HEALTH', domainNameSnapshot: 'Health', domainPerformanceScore: 20, isCriticalDomain: true }],
          },
          {
            studyId: 'st1', surveyId: 'sv1', villageId: '', priorityScore: 40, priorityStatus: 'MEDIUM',
            calculatedAt: new Date('2026-07-02'),
            domainComponents: [{ domainKey: 'HEALTH', domainNameSnapshot: 'Health', domainPerformanceScore: 60, isCriticalDomain: true }],
          },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      priorityOverview: {
        byStatus: Array<{ status: string; count: number }>;
        domainComparison: Array<{ domainKey: string; avgPerformanceScore: number; assessmentCount: number }>;
        topPriorityVillages: Array<{ villageId: string }>;
      };
    };

    // byStatus is derived from the same real-village dedup as
    // topPriorityVillages below (see buildPriorityOverview) — the
    // villageId="" consolidated row is excluded from both, not just the
    // scorecard list, so its MEDIUM status never appears here either.
    expect(report.priorityOverview.byStatus).toEqual([{ status: 'HIGH', count: 1 }]);
    expect(report.priorityOverview.domainComparison).toEqual([
      { domainKey: 'HEALTH', domainName: 'Health', avgPerformanceScore: 40, isCriticalDomain: true, assessmentCount: 2 },
    ]);
    expect(report.priorityOverview.topPriorityVillages).toEqual([
      { studyId: 'st1', surveyId: 'sv1', villageId: 'Village A', priorityScore: 25, priorityStatus: 'HIGH' },
    ]);
  });

  it('breaks down organizations by region/governorate/center and studies by region (derived through the org, not a Study column)', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Org 1', isActive: true, createdAt: new Date(), updatedAt: new Date(), regionId: 'r1' },
          { id: 'o2', name: 'Org 2', isActive: true, createdAt: new Date(), updatedAt: new Date(), regionId: 'r1' },
        ],
        regions: [{ id: 'r1', name: 'Riyadh' }],
        governorates: [{ id: 'g1', name: 'Al-Kharj' }],
        centers: [{ id: 'c1', name: 'Al-Hayathim' }],
        orgGovernorates: [{ orgId: 'o1', governorateId: 'g1' }, { orgId: 'o2', governorateId: 'g1' }],
        orgCenters: [{ orgId: 'o1', centerId: 'c1' }],
        studies: [
          { id: 's1', orgId: 'o1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
          { id: 's2', orgId: 'o2', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        ],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      geography: {
        organizationsByRegion: Array<{ id: string; name: string; count: number }>;
        organizationsByGovernorate: Array<{ id: string; name: string; count: number }>;
        organizationsByCenter: Array<{ id: string; name: string; count: number }>;
        studiesByRegion: Array<{ id: string; name: string; count: number }>;
      };
    };

    expect(report.geography.organizationsByRegion).toEqual([{ id: 'r1', name: 'Riyadh', count: 2 }]);
    expect(report.geography.organizationsByGovernorate).toEqual([{ id: 'g1', name: 'Al-Kharj', count: 2 }]);
    expect(report.geography.organizationsByCenter).toEqual([{ id: 'c1', name: 'Al-Hayathim', count: 1 }]);
    expect(report.geography.studiesByRegion).toEqual([{ id: 'r1', name: 'Riyadh', count: 2 }]);
  });

  it('exports a real, non-empty PDF and Excel file built from the live report', async () => {
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Org 1', isActive: true, createdAt: new Date(), updatedAt: new Date() },
        ],
        domains: [{ code: 'H', name: 'Health', isActive: true, displayOrder: 1 }],
      }) as never,
    );

    const [pdf, excel] = (await runAs('system_admin', () =>
      Promise.all([service.exportReport('pdf'), service.exportReport('excel')]),
    )) as [
      { filename: string; contentType: string; body: Buffer },
      { filename: string; contentType: string; body: Buffer },
    ];

    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.filename).toMatch(/^ncnp-consolidated-report-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(pdf.body.byteLength).toBeGreaterThan(0);
    expect(pdf.body.subarray(0, 4).toString('ascii')).toBe('%PDF'); // real PDF magic bytes, not a stub

    expect(excel.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(excel.filename).toMatch(/^ncnp-consolidated-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(excel.body.byteLength).toBeGreaterThan(0);
    expect(excel.body.subarray(0, 2).toString('ascii')).toBe('PK'); // real xlsx (zip) magic bytes
  });

  it('builds org summary, top-orgs-by-study-count, studies-created trend, and survey geography (governorate/center via each survey\'s own Need)', async () => {
    const staleDate = new Date();
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [
          { id: 'o1', name: 'Org 1', isActive: true, createdAt: staleDate, updatedAt: staleDate, regionId: 'r1' },
          { id: 'o2', name: 'Org 2', isActive: false, createdAt: staleDate, updatedAt: staleDate, regionId: 'r1' },
        ],
        regions: [{ id: 'r1', name: 'Riyadh' }],
        governorates: [{ id: 'g1', name: 'Al-Kharj' }],
        centers: [{ id: 'c1', name: 'Al-Hayathim' }],
        studies: [
          { id: 's1', orgId: 'o1', status: 'active', createdAt: staleDate, updatedAt: staleDate },
          { id: 's2', orgId: 'o1', status: 'active', createdAt: staleDate, updatedAt: staleDate },
        ],
        surveys: [
          { id: 'sv1', orgId: 'o1', needId: 'n1', status: 'PUBLISHED', createdAt: staleDate },
          { id: 'sv2', orgId: 'o1', needId: 'n2', status: 'PUBLISHED', createdAt: staleDate },
        ],
        // Both surveys' own Needs (n1, n2) select the same single
        // governorate/center here — each survey contributes exactly once
        // (count: 2 total), not fanned out by however many governorates
        // the parent org happens to serve more broadly (org o1 itself has
        // no organisationGovernorate/organisationCenter rows at all in this
        // fixture, proving those tables are no longer consulted for this).
        needGovernorates: [{ needId: 'n1', governorateId: 'g1' }, { needId: 'n2', governorateId: 'g1' }],
        needCenters: [{ needId: 'n1', centerId: 'c1' }, { needId: 'n2', centerId: 'c1' }],
        responses: [{ id: 'r1', orgId: 'o1', submittedAt: staleDate, regionId: 'r1' }],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      orgSummary: {
        totalOrganizations: number;
        byStudies: Array<{ organizationId: string; studyCount: number; surveyCount: number; responseCount: number; isActive: boolean }>;
        bySurveys: Array<{ organizationId: string; studyCount: number; surveyCount: number; responseCount: number; isActive: boolean }>;
        byResponses: Array<{ organizationId: string; studyCount: number; surveyCount: number; responseCount: number; isActive: boolean }>;
      };
      studyOverview: { topOrgsByStudyCount: Array<{ organizationId: string; studyCount: number }>; totalOrganizations: number };
      surveyGeography: { byRegion: Array<{ id: string; count: number }>; byGovernorate: Array<{ id: string; name: string; count: number }>; byCenter: Array<{ id: string; name: string; count: number }> };
      regionSummary: Array<{ regionId: string; surveyCount: number; responseCount: number; avgResponsesPerSurvey: number }>;
    };

    expect(report.orgSummary.totalOrganizations).toBe(2);
    expect(report.orgSummary.byStudies[0]).toEqual({
      organizationId: 'o1',
      organizationName: 'Org 1',
      studyCount: 2,
      surveyCount: 2,
      responseCount: 1,
      isActive: true,
    });

    expect(report.studyOverview.topOrgsByStudyCount[0]).toEqual({ organizationId: 'o1', organizationName: 'Org 1', studyCount: 2 });
    expect(report.studyOverview.totalOrganizations).toBe(2);

    expect(report.surveyGeography.byRegion).toEqual([{ id: 'r1', name: 'Riyadh', count: 2 }]);
    expect(report.surveyGeography.byGovernorate).toEqual([{ id: 'g1', name: 'Al-Kharj', count: 2 }]);
    expect(report.surveyGeography.byCenter).toEqual([{ id: 'c1', name: 'Al-Hayathim', count: 2 }]);

    expect(report.regionSummary).toEqual([{ regionId: 'r1', regionName: 'Riyadh', surveyCount: 2, responseCount: 1, avgResponsesPerSurvey: 0.5 }]);
  });

  it('does not fan a survey out across every governorate/center its org happens to serve — only the ones its own Need selected', async () => {
    // Org o1 serves TWO governorates/centers broadly (organisationGovernorate/
    // organisationCenter below), but its one survey's Need (n1) only
    // selected ONE of each — the real bug this guards against: the old
    // implementation joined through the org's org-wide links and would have
    // attributed this single survey to both g1 and g2 (and both c1/c2),
    // double-counting it in the by-governorate/by-center breakdowns.
    const staleDate = new Date();
    const service = new NcnpReportService(
      fakeTenant({
        organisations: [{ id: 'o1', name: 'Org 1', isActive: true, createdAt: staleDate, updatedAt: staleDate, regionId: 'r1' }],
        regions: [{ id: 'r1', name: 'Riyadh' }],
        governorates: [{ id: 'g1', name: 'Al-Kharj' }, { id: 'g2', name: 'Al-Quwayiyah' }],
        centers: [{ id: 'c1', name: 'Al-Hayathim' }, { id: 'c2', name: 'Dhurma' }],
        orgGovernorates: [{ orgId: 'o1', governorateId: 'g1' }, { orgId: 'o1', governorateId: 'g2' }],
        orgCenters: [{ orgId: 'o1', centerId: 'c1' }, { orgId: 'o1', centerId: 'c2' }],
        surveys: [{ id: 'sv1', orgId: 'o1', needId: 'n1', status: 'PUBLISHED', createdAt: staleDate }],
        needGovernorates: [{ needId: 'n1', governorateId: 'g1' }],
        needCenters: [{ needId: 'n1', centerId: 'c1' }],
      }) as never,
    );

    const report = (await runAs('system_admin', () => service.getReport())) as {
      surveyGeography: { byGovernorate: Array<{ id: string; name: string; count: number }>; byCenter: Array<{ id: string; name: string; count: number }> };
    };

    expect(report.surveyGeography.byGovernorate).toEqual([{ id: 'g1', name: 'Al-Kharj', count: 1 }]);
    expect(report.surveyGeography.byCenter).toEqual([{ id: 'c1', name: 'Al-Hayathim', count: 1 }]);
  });
});
