import { EXCLUDE_MERGED } from '../needs/need-visibility';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { getOrgStore, requireActor } from '../../tenancy/org-context';
import { roleByKey } from '../../rbac/role-matrix';
import { AuditService } from '../audit/audit.service';
import { renderReportExcel } from '../reports/excel-builder';
import { buildNcnpReportDoc } from './ncnp-report-doc';
import { renderNcnpReportPdf } from './ncnp-report-pdf';
import type {
  NcnpAgeBracketBreakdown,
  NcnpCriticalNeedsOverview,
  NcnpDataQualityNotes,
  NcnpDomainBreakdown,
  NcnpDomainComparison,
  NcnpDomainRegionIntersection,
  NcnpGenderBreakdown,
  NcnpGeographyOverview,
  NcnpMonthlyPoint,
  NcnpNamedBreakdown,
  NcnpNeedsGeography,
  NcnpOrgHealth,
  NcnpOrgResponseStat,
  NcnpOrgSummary,
  NcnpOrgSummaryRow,
  NcnpPeriodStat,
  NcnpPriorityLevelBreakdown,
  NcnpPriorityNeedRow,
  NcnpPublicLinkStatus,
  NcnpPriorityOverview,
  NcnpRegionBreakdown,
  NcnpRegionSummaryRow,
  NcnpRegionSurveyStatus,
  NcnpRejectionReasonBreakdown,
  NcnpReport,
  NcnpResponseAnalytics,
  NcnpStudyOverview,
  NcnpStudyStatus,
  NcnpSubDomainBreakdown,
  NcnpSurveyAnalytics,
  NcnpSurveyGeography,
  NcnpSurveyStatus,
  NcnpTopOrgByStudyCount,
  NcnpVillageScorecard,
} from './ncnp-report.types';

const DEFAULT_PERIOD_DAYS = 30;
const DEFAULT_DORMANT_DAYS = 90;
const NEEDS_ATTENTION_LIMIT = 10;
const TREND_MONTHS = 12;
const TOP_ORGS_LIMIT = 5;
const TOP_PRIORITY_VILLAGES_LIMIT = 10;
const PRIORITY_NEEDS_LIST_LIMIT = 10;
const DOMAIN_REGION_INTERSECTION_LIMIT = 15;
// VillagePriorityAssessment.domainComponents is a JSON array — aggregating
// it needs the rows in app memory (no raw SQL precedent anywhere in this
// codebase to do it in Postgres via jsonb_array_elements). Capped to the
// most recently calculated rows rather than fetched unbounded, since this
// table has no upper bound in principle. Revisit if this cap is ever
// actually hit in practice.
const PRIORITY_ASSESSMENT_SAMPLE_SIZE = 1000;

function periodStat(current: number, previous: number): NcnpPeriodStat {
  return {
    current,
    previous,
    changePct: previous === 0 ? null : ((current - previous) / previous) * 100,
  };
}

// Cross-organization, read-only NCNP Consolidated Report. Same real cross-org
// path as SupervisorOverviewService (TenantPrismaService.runAsSupervisor) —
// never a placeholder, and deliberately its own module rather than folding
// into ReportsModule/CollectiveDashboardModule, both of which stay
// single-org-scoped for every other role.
@Injectable()
export class NcnpReportService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async getReport(
    periodDays: number = DEFAULT_PERIOD_DAYS,
    dormantDays: number = DEFAULT_DORMANT_DAYS,
  ): Promise<NcnpReport> {
    this.assertCrossEntity();

    const now = new Date();
    const currentPeriodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const previousPeriodStart = new Date(currentPeriodStart.getTime() - periodDays * 24 * 60 * 60 * 1000);
    const dormantCutoff = new Date(now.getTime() - dormantDays * 24 * 60 * 60 * 1000);

    // Every count()/groupBy() below runs as its own runAsSupervisor call —
    // same "one query per call, joined in memory" shape as
    // SupervisorOverviewService — but uses count()/groupBy() rather than
    // findMany() for anything touching Study/Survey/SurveyResponse: those
    // grow with real usage (SurveyResponse especially, one row per citizen
    // submission), unlike the small, bounded Organisation table.
    const [
      organisations,
      totalStudies,
      studiesCurrent,
      studiesPrevious,
      studyStatusGroups,
      studyActivityByOrg,
      totalSurveys,
      surveysCurrent,
      surveysPrevious,
      surveyActivityByOrg,
      totalResponses,
      responsesCurrent,
      responsesPrevious,
      responseActivityByOrg,
      totalOrganizations,
      orgsCurrent,
      orgsPrevious,
      domains,
      needDomainGroups,
      publicLinkStatusGroups,
    ] = await Promise.all([
      this.tenant.runAsSupervisor((tx) =>
        tx.organisation.findMany({ select: { id: true, name: true, isActive: true, updatedAt: true } }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.study.count()),
      this.tenant.runAsSupervisor((tx) => tx.study.count({ where: { createdAt: { gte: currentPeriodStart } } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.study.count({ where: { createdAt: { gte: previousPeriodStart, lt: currentPeriodStart } } }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.study.groupBy({ by: ['status'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.study.groupBy({ by: ['orgId'], _max: { updatedAt: true } })),
      this.tenant.runAsSupervisor((tx) => tx.survey.count()),
      this.tenant.runAsSupervisor((tx) => tx.survey.count({ where: { createdAt: { gte: currentPeriodStart } } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.survey.count({ where: { createdAt: { gte: previousPeriodStart, lt: currentPeriodStart } } }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.survey.groupBy({ by: ['orgId'], _max: { createdAt: true } })),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.count()),
      this.tenant.runAsSupervisor((tx) =>
        tx.surveyResponse.count({ where: { submittedAt: { gte: currentPeriodStart } } }),
      ),
      this.tenant.runAsSupervisor((tx) =>
        tx.surveyResponse.count({ where: { submittedAt: { gte: previousPeriodStart, lt: currentPeriodStart } } }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.groupBy({ by: ['orgId'], _max: { submittedAt: true } })),
      this.tenant.runAsSupervisor((tx) => tx.organisation.count()),
      this.tenant.runAsSupervisor((tx) => tx.organisation.count({ where: { createdAt: { gte: currentPeriodStart } } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.organisation.count({ where: { createdAt: { gte: previousPeriodStart, lt: currentPeriodStart } } }),
      ),
      this.tenant.runAsSupervisor((tx) =>
        tx.domain.findMany({ where: { isActive: true }, orderBy: { displayOrder: 'asc' } }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.needDomain.groupBy({ by: ['domain'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.publicSurveyLink.groupBy({ by: ['isActive'], _count: true })),
    ]);

    const lastActivityByOrg = this.mergeLastActivity(
      organisations.map((o) => ({ orgId: o.id, at: o.updatedAt })),
      studyActivityByOrg.map((g) => ({ orgId: g.orgId, at: g._max.updatedAt })),
      surveyActivityByOrg.map((g) => ({ orgId: g.orgId, at: g._max.createdAt })),
      responseActivityByOrg.map((g) => ({ orgId: g.orgId, at: g._max.submittedAt })),
    );

    const orgHealth = this.buildOrgHealth(organisations, lastActivityByOrg, dormantCutoff, dormantDays);
    const studyStatus = this.buildStudyStatus(studyStatusGroups);
    const needDomains = this.buildDomainBreakdown(domains, needDomainGroups);
    const publicLinkStatus = this.buildPublicLinkStatus(publicLinkStatusGroups);

    const trendStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1));
    const orgById = new Map(organisations.map((o) => [o.id, o]));

    const [
      surveyStatusGroups,
      surveyStatusByOrgGroups,
      regions,
      organisationsWithRegion,
      publishedSurveysByOrg,
      monthlyResponses,
      responsesByRegionGroups,
      genderGroups,
      ageBracketGroups,
      responsesByOrgGroups,
      rejectionAuditRows,
      priorityAssessmentSample,
      organisationsByRegionGroups,
      governorates,
      organisationsByGovernorateGroups,
      centers,
      organisationsByCenterGroups,
      studiesByOrgGroups,
    ] = await Promise.all([
      this.tenant.runAsSupervisor((tx) => tx.survey.groupBy({ by: ['status'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.survey.groupBy({ by: ['orgId', 'status'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.region.findMany({ select: { id: true, name: true } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.organisation.findMany({ select: { id: true, regionId: true } }),
      ),
      this.tenant.runAsSupervisor((tx) =>
        tx.survey.groupBy({ by: ['orgId'], where: { status: 'PUBLISHED' }, _count: true }),
      ),
      this.tenant.runAsSupervisor((tx) =>
        tx.surveyResponse.findMany({
          select: { submittedAt: true },
          where: { submittedAt: { gte: trendStart } },
        }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.groupBy({ by: ['regionId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.groupBy({ by: ['gender'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.groupBy({ by: ['ageBracket'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.surveyResponse.groupBy({ by: ['orgId'], _count: true })),
      // Historical rejection *events*, not "surveys currently REJECTED" —
      // Survey.rejectionReasonCode is cleared on resubmit, so a
      // rejected-then-corrected-then-published survey would otherwise vanish
      // from this breakdown entirely. rejectSurvey's audit record (action
      // 'edit', entityLabel 'Survey rejected') is the durable record of
      // every rejection that ever happened, regardless of what the survey's
      // current status is.
      this.tenant.runAsSupervisor((tx) =>
        tx.auditLog.findMany({
          where: { entityType: 'survey', action: 'edit', entityLabel: 'Survey rejected' },
          select: { metadata: true },
        }),
      ),
      this.tenant.runAsSupervisor((tx) =>
        tx.villagePriorityAssessment.findMany({
          select: {
            studyId: true,
            surveyId: true,
            villageId: true,
            priorityScore: true,
            priorityStatus: true,
            domainComponents: true,
          },
          orderBy: { calculatedAt: 'desc' },
          take: PRIORITY_ASSESSMENT_SAMPLE_SIZE,
        }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.organisation.groupBy({ by: ['regionId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.governorate.findMany({ select: { id: true, name: true } })),
      this.tenant.runAsSupervisor((tx) => tx.organisationGovernorate.groupBy({ by: ['governorateId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.center.findMany({ select: { id: true, name: true } })),
      this.tenant.runAsSupervisor((tx) => tx.organisationCenter.groupBy({ by: ['centerId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.study.groupBy({ by: ['orgId'], _count: true })),
    ]);

    const regionNameById = new Map(regions.map((r) => [r.id, r.name]));
    const regionIdByOrg = new Map(organisationsWithRegion.map((o) => [o.id, o.regionId]));

    // Rejected surveys with no code (rejected before this feature existed,
    // or a stale audit row missing the change entry) are grouped under
    // "UNSPECIFIED" rather than dropped.
    const rejectionReasonCounts = new Map<string, number>();
    for (const row of rejectionAuditRows) {
      const metadata = row.metadata as { changes?: Array<{ field: string; after: unknown }> } | null;
      const reasonChange = metadata?.changes?.find((c) => c.field === 'Rejection Reason');
      const reasonCode = typeof reasonChange?.after === 'string' ? reasonChange.after : 'UNSPECIFIED';
      rejectionReasonCounts.set(reasonCode, (rejectionReasonCounts.get(reasonCode) ?? 0) + 1);
    }

    const surveyAnalytics = this.buildSurveyAnalytics(
      surveyStatusGroups,
      surveyStatusByOrgGroups,
      regionIdByOrg,
      regionNameById,
      publishedSurveysByOrg,
      totalResponses,
      rejectionReasonCounts,
    );
    const responseAnalytics = this.buildResponseAnalytics(
      monthlyResponses,
      responsesByRegionGroups,
      regionNameById,
      genderGroups,
      ageBracketGroups,
      responsesByOrgGroups,
      publishedSurveysByOrg,
      orgById,
    );
    const priorityOverview = this.buildPriorityOverview(priorityAssessmentSample);
    const geography = this.buildGeography(
      organisationsByRegionGroups,
      regionNameById,
      governorates,
      organisationsByGovernorateGroups,
      centers,
      organisationsByCenterGroups,
      studiesByOrgGroups,
      regionIdByOrg,
    );

    const [
      surveysByOrgGroups,
      surveyNeedIds,
      needGovernorateRows,
      needCenterRows,
      monthlyStudies,
      needsByOrgGroups,
      totalNeeds,
      needsUnclassifiedCount,
      needSubDomainGroups,
      needDomainOrgRows,
      needsForPriority,
      evidenceByNeedGroups,
      confidenceFlagGroups,
      duplicateResponseCount,
      surveyQuestionIndicators,
    ] = await Promise.all([
      this.tenant.runAsSupervisor((tx) => tx.survey.groupBy({ by: ['orgId'], _count: true })),
      // Each survey's OWN Need's governorates/centers — NOT the org's
      // broader organisationGovernorate/organisationCenter links (an org
      // can serve several governorates; attributing that org's *entire*
      // survey count to every one of them fans a single survey out into
      // several, inflating the total well past the real survey count. A
      // Need selects its own specific governorate(s)/center(s), so joining
      // through the Need is the accurate scope for "where was this survey
      // actually run.")
      this.tenant.runAsSupervisor((tx) => tx.survey.findMany({ select: { id: true, needId: true } })),
      this.tenant.runAsSupervisor((tx) => tx.needGovernorate.findMany({ select: { needId: true, governorateId: true } })),
      this.tenant.runAsSupervisor((tx) => tx.needCenter.findMany({ select: { needId: true, centerId: true } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.study.findMany({ select: { createdAt: true }, where: { createdAt: { gte: trendStart } } }),
      ),
      // Kingdom-wide Needs rollup by region — Needs themselves, not
      // Organizations/Surveys (see NcnpNeedsGeography).
      this.tenant.runAsSupervisor((tx) => tx.need.groupBy({ by: ['orgId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.need.count({ where: EXCLUDE_MERGED })),
      // "Unclassified" = never assigned a Domain at all — Need.domain is
      // the authoritative field (always mirrors needDomains[0], see the
      // schema comment on Need.domain), so null here means literally no
      // classification decision has ever been made for this Need.
      this.tenant.runAsSupervisor((tx) => tx.need.count({ where: { domain: null, ...EXCLUDE_MERGED } })),
      this.tenant.runAsSupervisor((tx) => tx.needDomain.groupBy({ by: ['domain', 'subDomain'], _count: true })),
      // orgId is denormalized directly onto NeedDomain (see schema comment),
      // so this is a real (org's region, domain) pair per row without a
      // second join back through Need.
      this.tenant.runAsSupervisor((tx) => tx.needDomain.findMany({ select: { orgId: true, domain: true } })),
      this.tenant.runAsSupervisor((tx) =>
        tx.need.findMany({
          select: { id: true, title: true, orgId: true, domain: true, subDomain: true, source: true, referenceId: true },
        }),
      ),
      this.tenant.runAsSupervisor((tx) => tx.evidence.groupBy({ by: ['needId'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.responseQualityResult.groupBy({ by: ['confidenceFlag'], _count: true })),
      this.tenant.runAsSupervisor((tx) => tx.responseQualityResult.count({ where: { isDuplicate: true } })),
      // No dedicated Indicator model exists in this schema — Question Bank's
      // own `indicator`/`kpi` free-text fields are the closest real,
      // populated concept (see the Unified Need Record Schema gap analysis,
      // docs/ncnp-unified-need-record-schema-analysis.md). Joined via
      // Need -> Survey -> SurveyQuestion -> Question, one row per
      // (survey, question) pair — a survey can touch several indicators
      // across several domains (e.g. a village-conditions module bundling
      // Infrastructure questions into an otherwise Health survey), so
      // domain/subDomain are selected here too and used to pick only the
      // question(s) matching the Need's own classified domain, not just
      // "the first row found" regardless of topic.
      this.tenant.runAsSupervisor((tx) =>
        tx.surveyQuestion.findMany({
          where: { question: { indicator: { not: null } } },
          select: { surveyId: true, question: { select: { indicator: true, domain: true, subDomain: true } } },
        }),
      ),
    ]);

    const governorateNameById = new Map(governorates.map((g) => [g.id, g.name]));
    const centerNameById = new Map(centers.map((c) => [c.id, c.name]));

    const orgSummary = this.buildOrgSummary(organisations, studiesByOrgGroups, surveysByOrgGroups, responsesByOrgGroups);
    const studyOverview = this.buildStudyOverview(studiesByOrgGroups, orgById, totalOrganizations, monthlyStudies);
    const surveyGeography = this.buildSurveyGeography(
      surveysByOrgGroups,
      regionIdByOrg,
      regionNameById,
      surveyNeedIds,
      needGovernorateRows,
      governorateNameById,
      needCenterRows,
      centerNameById,
    );
    const regionSummary = this.buildRegionSummary(surveyGeography.byRegion, responseAnalytics.responsesByRegion);

    const needsGeography = this.buildNeedsGeography(
      needsByOrgGroups,
      regionIdByOrg,
      regionNameById,
      needGovernorateRows,
      governorateNameById,
      needCenterRows,
      centerNameById,
    );
    const needSubDomains = this.buildSubDomainBreakdown(needSubDomainGroups);
    const criticalNeeds = this.buildCriticalNeeds(
      needsForPriority,
      orgById,
      surveyNeedIds,
      priorityAssessmentSample,
      evidenceByNeedGroups,
      regionIdByOrg,
      regionNameById,
      surveyQuestionIndicators,
    );
    const dataQualityNotes = this.buildDataQualityNotes(
      totalResponses,
      confidenceFlagGroups,
      duplicateResponseCount,
      totalNeeds,
      evidenceByNeedGroups,
      needsUnclassifiedCount,
    );
    const domainRegionIntersections = this.buildDomainRegionIntersections(needDomainOrgRows, regionIdByOrg, regionNameById);

    return {
      generatedAt: now.toISOString(),
      summary: {
        totals: {
          organizations: totalOrganizations,
          studies: totalStudies,
          surveys: totalSurveys,
          responses: totalResponses,
          needs: totalNeeds,
        },
        newThisPeriod: {
          periodDays,
          organizations: periodStat(orgsCurrent, orgsPrevious),
          studies: periodStat(studiesCurrent, studiesPrevious),
          surveys: periodStat(surveysCurrent, surveysPrevious),
          responses: periodStat(responsesCurrent, responsesPrevious),
        },
      },
      orgHealth,
      orgSummary,
      needDomains,
      needSubDomains,
      needsGeography,
      studyStatus,
      publicLinkStatus,
      studyOverview,
      geography,
      surveyAnalytics,
      surveyGeography,
      regionSummary,
      responseAnalytics,
      priorityOverview,
      criticalNeeds,
      dataQualityNotes,
      domainRegionIntersections,
    };
  }

  // PDF uses a dedicated, page-aware layout (ncnp-report-pdf.ts) that mirrors
  // the live UI's 6-page structure (masthead, running header/footer, page
  // badges) — the generic buildReportDoc/renderReportPdf pair every other
  // report type shares has no concept of pages at all, so it can't produce
  // that structure. Excel has no equivalent "pages" concept, so it still
  // reuses the generic ReportDoc pipeline (report-doc.ts, excel-builder.ts).
  // This report has no persisted `Report` row of its own (it's a live,
  // generated-on-request view, same as SupervisorOverview), so there's no
  // id/approval-status gate to check here — assertCrossEntity (via
  // getReport) is the only authorization.
  async exportReport(
    format: 'pdf' | 'excel',
    periodDays?: number,
    dormantDays?: number,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const report = await this.getReport(periodDays, dormantDays);
    const dateStamp = report.generatedAt.slice(0, 10);
    // Every export is audited with the actor's role (not just their user
    // id) — this report has no per-record entityId of its own (it's a
    // live, generated-on-request view, not a stored Report row), so
    // entityId is the export itself, keyed by date + format.
    const role = getOrgStore()?.role ?? null;
    await this.audit.record({
      action: 'export',
      entityType: 'ncnp_report',
      entityId: null,
      entityLabel: `NCNP Compiled Report exported (${format})`,
      metadata: { format, reviewerRole: role, generatedAt: report.generatedAt },
    });
    const actorId = requireActor();
    const actor = await this.tenant.runAsSupervisor((tx) => tx.user.findUnique({ where: { id: actorId }, select: { name: true } }));
    const generatedByName = actor?.name ?? '—';
    if (format === 'pdf') {
      return {
        filename: `ncnp-compiled-report-${dateStamp}.pdf`,
        contentType: 'application/pdf',
        body: renderNcnpReportPdf(report, generatedByName),
      };
    }
    return {
      filename: `ncnp-compiled-report-${dateStamp}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: await renderReportExcel(buildNcnpReportDoc(report, generatedByName)),
    };
  }

  private mergeLastActivity(
    ...sources: Array<Array<{ orgId: string; at?: Date | null }>>
  ): Map<string, Date | null> {
    const result = new Map<string, Date | null>();
    for (const source of sources) {
      for (const { orgId, at } of source) {
        if (!at) {
          if (!result.has(orgId)) result.set(orgId, null);
          continue;
        }
        const existing = result.get(orgId);
        if (!existing || at > existing) result.set(orgId, at);
      }
    }
    return result;
  }

  private buildOrgHealth(
    organisations: Array<{ id: string; name: string; isActive: boolean }>,
    lastActivityByOrg: Map<string, Date | null>,
    dormantCutoff: Date,
    dormantDays: number,
  ): NcnpOrgHealth {
    const active = organisations.filter((o) => o.isActive);
    const inactive = organisations.filter((o) => !o.isActive);
    const dormant = active.filter((o) => {
      const lastActivity = lastActivityByOrg.get(o.id) ?? null;
      return !lastActivity || lastActivity < dormantCutoff;
    });
    const needsAttention = dormant
      .map((o) => ({
        organizationId: o.id,
        organizationName: o.name,
        lastActivity: lastActivityByOrg.get(o.id)?.toISOString() ?? null,
      }))
      .sort((a, b) => (a.lastActivity ?? '').localeCompare(b.lastActivity ?? ''))
      .slice(0, NEEDS_ATTENTION_LIMIT);

    return {
      active: active.length,
      inactive: inactive.length,
      dormant: dormant.length,
      dormantDays,
      needsAttention,
    };
  }

  private buildStudyStatus(groups: Array<{ status: string; _count: number }>): NcnpStudyStatus {
    let active = 0;
    let archived = 0;
    for (const g of groups) {
      if (g.status === 'archived') archived += g._count;
      else active += g._count; // 'active' and any other/legacy value both count as non-archived
    }
    return { active, archived };
  }

  private buildPublicLinkStatus(groups: Array<{ isActive: boolean; _count: number }>): NcnpPublicLinkStatus {
    let open = 0;
    let closed = 0;
    for (const g of groups) {
      if (g.isActive) open += g._count;
      else closed += g._count;
    }
    return { open, closed };
  }

  private buildDomainBreakdown(
    domains: Array<{ code: string; name: string }>,
    needDomainGroups: Array<{ domain: string; _count: number }>,
  ): NcnpDomainBreakdown[] {
    const countByName = new Map(needDomainGroups.map((g) => [g.domain, g._count]));
    // Every active domain is always listed, even at 0 needs — this is the
    // fix for the client's "under-represents the methodology" finding: the
    // real domain count (whatever it currently is) drives this list, not a
    // hardcoded/truncated subset.
    return domains.map((d) => ({
      domainCode: d.code,
      domainName: d.name,
      needCount: countByName.get(d.name) ?? 0,
    }));
  }

  // NeedDomain already stores both domain and sub-domain names directly
  // (free text, not a code — see the model's own comment), so this is a
  // straight passthrough of the groupBy, sorted by count — no master-data
  // join needed the way buildDomainBreakdown needs one for zero-count
  // domains, since a sub-domain with zero Needs simply isn't a combination
  // that exists yet.
  private buildSubDomainBreakdown(
    groups: Array<{ domain: string; subDomain: string; _count: number }>,
  ): NcnpSubDomainBreakdown[] {
    return groups
      .map((g) => ({ domainName: g.domain, subDomainName: g.subDomain, needCount: g._count }))
      .sort((a, b) => b.needCount - a.needCount);
  }

  private toSurveyStatus(groups: Array<{ status: string; _count: number }>): NcnpSurveyStatus {
    const result: NcnpSurveyStatus = { draft: 0, submitted: 0, published: 0, rejected: 0 };
    for (const g of groups) {
      if (g.status === 'DRAFT') result.draft += g._count;
      else if (g.status === 'SUBMITTED') result.submitted += g._count;
      else if (g.status === 'PUBLISHED') result.published += g._count;
      else if (g.status === 'REJECTED') result.rejected += g._count;
    }
    return result;
  }

  private buildSurveyAnalytics(
    statusGroups: Array<{ status: string; _count: number }>,
    statusByOrgGroups: Array<{ orgId: string; status: string; _count: number }>,
    regionIdByOrg: Map<string, string | null>,
    regionNameById: Map<string, string>,
    publishedSurveysByOrg: Array<{ orgId: string; _count: number }>,
    totalResponses: number,
    rejectionReasonCounts: Map<string, number>,
  ): NcnpSurveyAnalytics {
    const statusPlatformWide = this.toSurveyStatus(statusGroups);

    // Orgs with no assigned region are excluded from the by-region
    // breakdown rather than folded into an "Unassigned" bucket — this
    // mirrors the same region-based charts elsewhere in the platform,
    // which only ever show real, named regions.
    const byRegion = new Map<string, Array<{ status: string; _count: number }>>();
    for (const g of statusByOrgGroups) {
      const regionId = regionIdByOrg.get(g.orgId);
      if (!regionId) continue;
      const list = byRegion.get(regionId) ?? [];
      list.push({ status: g.status, _count: g._count });
      byRegion.set(regionId, list);
    }
    const statusByRegion: NcnpRegionSurveyStatus[] = Array.from(byRegion.entries())
      .map(([regionId, groups]) => ({
        regionId,
        regionName: regionNameById.get(regionId) ?? 'Unknown region',
        count: groups.reduce((sum, g) => sum + g._count, 0),
        status: this.toSurveyStatus(groups),
      }))
      .sort((a, b) => b.count - a.count);

    const totalPublished = publishedSurveysByOrg.reduce((sum, g) => sum + g._count, 0);
    const avgResponsesPerPublishedSurvey = totalPublished === 0 ? 0 : totalResponses / totalPublished;

    // Counts every rejection *event* that ever happened (see the audit-log
    // query in getReport), not just surveys currently sitting at REJECTED —
    // so a rejected-then-corrected-then-published survey still counts here,
    // meaning this total can exceed statusPlatformWide.rejected.
    const rejectionReasonBreakdown: NcnpRejectionReasonBreakdown[] = Array.from(
      rejectionReasonCounts.entries(),
    )
      .map(([reasonCode, count]) => ({ reasonCode, count }))
      .sort((a, b) => b.count - a.count);

    return { statusPlatformWide, statusByRegion, avgResponsesPerPublishedSurvey, rejectionReasonBreakdown };
  }

  private buildResponseAnalytics(
    monthlyResponses: Array<{ submittedAt: Date }>,
    responsesByRegionGroups: Array<{ regionId: string | null; _count: number }>,
    regionNameById: Map<string, string>,
    genderGroups: Array<{ gender: string | null; _count: number }>,
    ageBracketGroups: Array<{ ageBracket: string | null; _count: number }>,
    responsesByOrgGroups: Array<{ orgId: string; _count: number }>,
    publishedSurveysByOrg: Array<{ orgId: string; _count: number }>,
    orgById: Map<string, { id: string; name: string }>,
  ): NcnpResponseAnalytics {
    const monthCounts = new Map<string, number>();
    for (const r of monthlyResponses) {
      // UTC, not local getFullYear()/getMonth() — this runs on whatever
      // timezone the server process happens to be in, and a local-time
      // bucket key would shift which calendar month a timestamp near
      // midnight UTC lands in depending on that offset (e.g. IST, UTC+5:30,
      // pushes anything after 18:30 UTC into the next day/month). Every
      // other date boundary in this service (period starts, dormant
      // cutoff) is plain epoch-ms arithmetic, which is timezone-agnostic —
      // UTC keeps this bucketing consistent with that and reproducible
      // regardless of where the app happens to be deployed.
      const key = `${r.submittedAt.getUTCFullYear()}-${String(r.submittedAt.getUTCMonth() + 1).padStart(2, '0')}`;
      monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
    }
    const monthlyTrend: NcnpMonthlyPoint[] = Array.from(monthCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count }));

    const responsesByRegion: NcnpRegionBreakdown[] = responsesByRegionGroups
      .filter((g) => g.regionId)
      .map((g) => ({
        regionId: g.regionId as string,
        regionName: regionNameById.get(g.regionId as string) ?? 'Unknown region',
        count: g._count,
      }))
      .sort((a, b) => b.count - a.count);

    const genderDistribution: NcnpGenderBreakdown[] = genderGroups
      .filter((g) => g.gender)
      .map((g) => ({ gender: g.gender as string, count: g._count }))
      .sort((a, b) => b.count - a.count);

    // Responses with no ageBracket predate this feature — excluded from the
    // distribution itself (never counted as a real bracket), but their
    // presence is surfaced separately via hasResponsesWithoutAgeBracket so
    // the report can disclose it instead of implying 100% coverage.
    const ageBracketDistribution: NcnpAgeBracketBreakdown[] = ageBracketGroups
      .filter((g) => g.ageBracket)
      .map((g) => ({ ageBracket: g.ageBracket as string, count: g._count }))
      .sort((a, b) => b.count - a.count);
    const hasResponsesWithoutAgeBracket = ageBracketGroups.some((g) => !g.ageBracket && g._count > 0);

    const topOrgsByTotalResponses: NcnpOrgResponseStat[] = responsesByOrgGroups
      .map((g) => ({ organizationId: g.orgId, organizationName: orgById.get(g.orgId)?.name ?? 'Unknown', value: g._count }))
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP_ORGS_LIMIT);

    const publishedByOrg = new Map(publishedSurveysByOrg.map((g) => [g.orgId, g._count]));
    const topOrgsByAvgResponsesPerSurvey: NcnpOrgResponseStat[] = responsesByOrgGroups
      .map((g) => {
        const published = publishedByOrg.get(g.orgId) ?? 0;
        return {
          organizationId: g.orgId,
          organizationName: orgById.get(g.orgId)?.name ?? 'Unknown',
          value: published === 0 ? 0 : g._count / published,
          published,
        };
      })
      .filter((o) => o.published > 0) // an org with no published survey has no meaningful "per survey" average
      .sort((a, b) => b.value - a.value)
      .slice(0, TOP_ORGS_LIMIT)
      .map(({ organizationId, organizationName, value }) => ({ organizationId, organizationName, value }));

    return {
      monthlyTrend,
      responsesByRegion,
      genderDistribution,
      ageBracketDistribution,
      hasResponsesWithoutAgeBracket,
      topOrgsByTotalResponses,
      topOrgsByAvgResponsesPerSurvey,
    };
  }

  private buildPriorityOverview(
    sample: Array<{
      studyId: string;
      surveyId: string;
      villageId: string;
      priorityScore: unknown;
      priorityStatus: string;
      domainComponents: unknown;
    }>,
  ): NcnpPriorityOverview {
    // villageId === '' is the study/survey-level consolidated row (see
    // schema comment), not a real village — excluded below. A village can
    // have more than one assessment row (re-assessed after new data, or
    // assessed against more than one study/survey) — `sample` is one row per
    // assessment, not per village. Deduping here (kept for both byStatus and
    // topPriorityVillages below) keeps the two counts consistent — computing
    // byStatus from the raw DB groupBy (one count per row) while
    // topPriorityVillages deduped by village meant the two disagreed
    // whenever a village had more than one assessment (e.g. "3 villages" in
    // the status donut against only 2 rows in the table below it). `sample`
    // is already ordered by calculatedAt desc, so the first row seen per
    // villageId here is that village's latest assessment.
    const latestByVillage = new Map<string, (typeof sample)[number]>();
    for (const row of sample) {
      if (row.villageId === '' || latestByVillage.has(row.villageId)) continue;
      latestByVillage.set(row.villageId, row);
    }
    const byStatusCounts = new Map<string, number>();
    for (const row of latestByVillage.values()) {
      byStatusCounts.set(row.priorityStatus, (byStatusCounts.get(row.priorityStatus) ?? 0) + 1);
    }
    const byStatus: NcnpPriorityLevelBreakdown[] = Array.from(byStatusCounts.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // domainComponents is a JSON array — see the schema comment on
    // VillagePriorityAssessment for the element shape. Guarded field access
    // throughout since this is `unknown`, not a typed Prisma model field.
    interface DomainComponent {
      domainKey?: unknown;
      domainNameSnapshot?: unknown;
      domainPerformanceScore?: unknown;
      isCriticalDomain?: unknown;
    }
    const domainAgg = new Map<string, { name: string; sum: number; count: number; critical: boolean }>();
    for (const row of sample) {
      const components = Array.isArray(row.domainComponents) ? (row.domainComponents as DomainComponent[]) : [];
      for (const c of components) {
        if (typeof c.domainKey !== 'string' || typeof c.domainPerformanceScore !== 'number') continue;
        const existing = domainAgg.get(c.domainKey) ?? {
          name: typeof c.domainNameSnapshot === 'string' ? c.domainNameSnapshot : c.domainKey,
          sum: 0,
          count: 0,
          critical: Boolean(c.isCriticalDomain),
        };
        existing.sum += c.domainPerformanceScore;
        existing.count += 1;
        domainAgg.set(c.domainKey, existing);
      }
    }
    const domainComparison: NcnpDomainComparison[] = Array.from(domainAgg.entries())
      .map(([domainKey, d]) => ({
        domainKey,
        domainName: d.name,
        avgPerformanceScore: d.sum / d.count,
        isCriticalDomain: d.critical,
        assessmentCount: d.count,
      }))
      .sort((a, b) => a.avgPerformanceScore - b.avgPerformanceScore); // lowest performance (highest concern) first

    // Lower priorityScore = higher priority (schema comment: "Low = high
    // priority"). Reuses the same latestByVillage dedup computed above for
    // byStatus, so the two numbers can never disagree.
    const topPriorityVillages: NcnpVillageScorecard[] = Array.from(latestByVillage.values())
      .map((row) => ({
        studyId: row.studyId,
        surveyId: row.surveyId,
        villageId: row.villageId,
        priorityScore: Number(row.priorityScore),
        priorityStatus: row.priorityStatus,
      }))
      .sort((a, b) => a.priorityScore - b.priorityScore)
      .slice(0, TOP_PRIORITY_VILLAGES_LIMIT);

    return { byStatus, domainComparison, topPriorityVillages };
  }

  private buildGeography(
    organisationsByRegionGroups: Array<{ regionId: string | null; _count: number }>,
    regionNameById: Map<string, string>,
    governorates: Array<{ id: string; name: string }>,
    organisationsByGovernorateGroups: Array<{ governorateId: string; _count: number }>,
    centers: Array<{ id: string; name: string }>,
    organisationsByCenterGroups: Array<{ centerId: string; _count: number }>,
    studiesByOrgGroups: Array<{ orgId: string; _count: number }>,
    regionIdByOrg: Map<string, string | null>,
  ): NcnpGeographyOverview {
    const governorateNameById = new Map(governorates.map((g) => [g.id, g.name]));
    const centerNameById = new Map(centers.map((c) => [c.id, c.name]));

    const toBreakdown = (
      groups: Array<{ id: string | null; count: number }>,
      nameById: Map<string, string>,
    ): NcnpNamedBreakdown[] =>
      groups
        .filter((g): g is { id: string; count: number } => Boolean(g.id))
        .map((g) => ({ id: g.id, name: nameById.get(g.id) ?? 'Unknown', count: g.count }))
        .sort((a, b) => b.count - a.count);

    const organizationsByRegion = toBreakdown(
      organisationsByRegionGroups.map((g) => ({ id: g.regionId, count: g._count })),
      regionNameById,
    );
    const organizationsByGovernorate = toBreakdown(
      organisationsByGovernorateGroups.map((g) => ({ id: g.governorateId, count: g._count })),
      governorateNameById,
    );
    const organizationsByCenter = toBreakdown(
      organisationsByCenterGroups.map((g) => ({ id: g.centerId, count: g._count })),
      centerNameById,
    );

    // Study has no region field of its own — always derived live from the
    // owning Organisation's regionId (see Study's schema comment), never a
    // second copy — so this aggregates through the org, not a Study column.
    const studiesByRegionCount = new Map<string, number>();
    for (const g of studiesByOrgGroups) {
      const regionId = regionIdByOrg.get(g.orgId);
      if (!regionId) continue;
      studiesByRegionCount.set(regionId, (studiesByRegionCount.get(regionId) ?? 0) + g._count);
    }
    const studiesByRegion = toBreakdown(
      Array.from(studiesByRegionCount.entries()).map(([id, count]) => ({ id, count })),
      regionNameById,
    );

    return { organizationsByRegion, organizationsByGovernorate, organizationsByCenter, studiesByRegion };
  }

  private buildOrgSummary(
    organisations: Array<{ id: string; name: string; isActive: boolean }>,
    studiesByOrgGroups: Array<{ orgId: string; _count: number }>,
    surveysByOrgGroups: Array<{ orgId: string; _count: number }>,
    responsesByOrgGroups: Array<{ orgId: string; _count: number }>,
  ): NcnpOrgSummary {
    const studyCountByOrg = new Map(studiesByOrgGroups.map((g) => [g.orgId, g._count]));
    const surveyCountByOrg = new Map(surveysByOrgGroups.map((g) => [g.orgId, g._count]));
    const responseCountByOrg = new Map(responsesByOrgGroups.map((g) => [g.orgId, g._count]));

    const allRows: NcnpOrgSummaryRow[] = organisations.map((o) => ({
      organizationId: o.id,
      organizationName: o.name,
      studyCount: studyCountByOrg.get(o.id) ?? 0,
      surveyCount: surveyCountByOrg.get(o.id) ?? 0,
      responseCount: responseCountByOrg.get(o.id) ?? 0,
      isActive: o.isActive,
    }));

    return {
      byStudies: [...allRows].sort((a, b) => b.studyCount - a.studyCount).slice(0, TOP_ORGS_LIMIT),
      bySurveys: [...allRows].sort((a, b) => b.surveyCount - a.surveyCount).slice(0, TOP_ORGS_LIMIT),
      byResponses: [...allRows].sort((a, b) => b.responseCount - a.responseCount).slice(0, TOP_ORGS_LIMIT),
      totalOrganizations: organisations.length,
    };
  }

  private buildStudyOverview(
    studiesByOrgGroups: Array<{ orgId: string; _count: number }>,
    orgById: Map<string, { id: string; name: string }>,
    totalOrganizations: number,
    monthlyStudies: Array<{ createdAt: Date }>,
  ): NcnpStudyOverview {
    const topOrgsByStudyCount: NcnpTopOrgByStudyCount[] = studiesByOrgGroups
      .map((g) => ({
        organizationId: g.orgId,
        organizationName: orgById.get(g.orgId)?.name ?? 'Unknown',
        studyCount: g._count,
      }))
      .sort((a, b) => b.studyCount - a.studyCount)
      .slice(0, TOP_ORGS_LIMIT);

    const monthCounts = new Map<string, number>();
    for (const s of monthlyStudies) {
      // UTC — see buildResponseAnalytics's monthly trend for why.
      const key = `${s.createdAt.getUTCFullYear()}-${String(s.createdAt.getUTCMonth() + 1).padStart(2, '0')}`;
      monthCounts.set(key, (monthCounts.get(key) ?? 0) + 1);
    }
    const studiesCreatedTrend: NcnpMonthlyPoint[] = Array.from(monthCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count }));

    return { topOrgsByStudyCount, totalOrganizations, studiesCreatedTrend };
  }

  // Surveys have no direct governorate/center link of their own — attributed
  // via their owning Organisation's OrganisationGovernorate/OrganisationCenter
  // rows, the same established approximation this report already uses for
  // organizationsByGovernorate/organizationsByCenter (an org spanning
  // multiple governorates has its survey count counted toward each one —
  // consistent with how orgs are counted, not a new methodology).
  private buildSurveyGeography(
    surveysByOrgGroups: Array<{ orgId: string; _count: number }>,
    regionIdByOrg: Map<string, string | null>,
    regionNameById: Map<string, string>,
    surveyNeedIds: Array<{ id: string; needId: string }>,
    needGovernorateRows: Array<{ needId: string; governorateId: string }>,
    governorateNameById: Map<string, string>,
    needCenterRows: Array<{ needId: string; centerId: string }>,
    centerNameById: Map<string, string>,
  ): NcnpSurveyGeography {
    const surveyCountByOrg = new Map(surveysByOrgGroups.map((g) => [g.orgId, g._count]));

    const byRegionCount = new Map<string, number>();
    for (const [orgId, count] of surveyCountByOrg) {
      const regionId = regionIdByOrg.get(orgId);
      if (!regionId) continue;
      byRegionCount.set(regionId, (byRegionCount.get(regionId) ?? 0) + count);
    }

    // One survey per Need, so each survey contributes exactly once per
    // governorate/center its own Need selected — a Need with 2 governorates
    // fans its one survey into both (correctly, since it genuinely covers
    // both), but a survey's count is never attributed to a governorate its
    // Need never selected just because the org happens to operate there
    // too (the previous organisationGovernorate/organisationCenter-based
    // approach did exactly that, inflating every multi-governorate org's
    // contribution by a multiple of how many governorates it served).
    const governorateIdsByNeed = new Map<string, string[]>();
    for (const row of needGovernorateRows) {
      const list = governorateIdsByNeed.get(row.needId) ?? [];
      list.push(row.governorateId);
      governorateIdsByNeed.set(row.needId, list);
    }
    const centerIdsByNeed = new Map<string, string[]>();
    for (const row of needCenterRows) {
      const list = centerIdsByNeed.get(row.needId) ?? [];
      list.push(row.centerId);
      centerIdsByNeed.set(row.needId, list);
    }

    const byGovernorateCount = new Map<string, number>();
    const byCenterCount = new Map<string, number>();
    for (const survey of surveyNeedIds) {
      for (const governorateId of governorateIdsByNeed.get(survey.needId) ?? []) {
        byGovernorateCount.set(governorateId, (byGovernorateCount.get(governorateId) ?? 0) + 1);
      }
      for (const centerId of centerIdsByNeed.get(survey.needId) ?? []) {
        byCenterCount.set(centerId, (byCenterCount.get(centerId) ?? 0) + 1);
      }
    }

    const toBreakdown = (counts: Map<string, number>, nameById: Map<string, string>): NcnpNamedBreakdown[] =>
      Array.from(counts.entries())
        .map(([id, count]) => ({ id, name: nameById.get(id) ?? 'Unknown', count }))
        .sort((a, b) => b.count - a.count);

    return {
      byRegion: toBreakdown(byRegionCount, regionNameById),
      byGovernorate: toBreakdown(byGovernorateCount, governorateNameById),
      byCenter: toBreakdown(byCenterCount, centerNameById),
    };
  }

  private buildRegionSummary(
    surveysByRegion: NcnpNamedBreakdown[],
    responsesByRegion: NcnpRegionBreakdown[],
  ): NcnpRegionSummaryRow[] {
    const responsesByRegionId = new Map(responsesByRegion.map((r) => [r.regionId, r.count]));
    return surveysByRegion
      .map((s) => {
        const responseCount = responsesByRegionId.get(s.id) ?? 0;
        return {
          regionId: s.id,
          regionName: s.name,
          surveyCount: s.count,
          responseCount,
          avgResponsesPerSurvey: s.count === 0 ? 0 : responseCount / s.count,
        };
      })
      .sort((a, b) => b.responseCount - a.responseCount);
  }

  // Kingdom-wide rollup of Needs themselves (not orgs, not surveys) by
  // region/governorate/center — same "fan out only across what this Need
  // itself actually selected" shape as buildSurveyGeography, one level
  // simpler since a Need's own governorate/center rows are already keyed by
  // needId directly (no survey hop needed).
  private buildNeedsGeography(
    needsByOrgGroups: Array<{ orgId: string; _count: number }>,
    regionIdByOrg: Map<string, string | null>,
    regionNameById: Map<string, string>,
    needGovernorateRows: Array<{ needId: string; governorateId: string }>,
    governorateNameById: Map<string, string>,
    needCenterRows: Array<{ needId: string; centerId: string }>,
    centerNameById: Map<string, string>,
  ): NcnpNeedsGeography {
    const byRegionCount = new Map<string, number>();
    for (const g of needsByOrgGroups) {
      const regionId = regionIdByOrg.get(g.orgId);
      if (!regionId) continue;
      byRegionCount.set(regionId, (byRegionCount.get(regionId) ?? 0) + g._count);
    }
    const byGovernorateCount = new Map<string, number>();
    for (const row of needGovernorateRows) {
      byGovernorateCount.set(row.governorateId, (byGovernorateCount.get(row.governorateId) ?? 0) + 1);
    }
    const byCenterCount = new Map<string, number>();
    for (const row of needCenterRows) {
      byCenterCount.set(row.centerId, (byCenterCount.get(row.centerId) ?? 0) + 1);
    }
    const toBreakdown = (counts: Map<string, number>, nameById: Map<string, string>): NcnpNamedBreakdown[] =>
      Array.from(counts.entries())
        .map(([id, count]) => ({ id, name: nameById.get(id) ?? 'Unknown', count }))
        .sort((a, b) => b.count - a.count);
    return {
      byRegion: toBreakdown(byRegionCount, regionNameById),
      byGovernorate: toBreakdown(byGovernorateCount, governorateNameById),
      byCenter: toBreakdown(byCenterCount, centerNameById),
    };
  }

  // Ranks Needs by criticality using real, existing data only — there is no
  // need-level severity_score/gap_type field in the schema today (see the
  // NCNP spec gap-analysis). Each Need's own Survey's village-priority
  // assessment (VillagePriorityAssessment — "low score = high priority") is
  // reused here: the consolidated (villageId="") row when present, else the
  // single named-village row, else the Need has no rankable score yet and is
  // excluded (never padded with a fabricated score). `primaryGap` is
  // derived from the assessment's own domainComponents JSON (the
  // lowest-performing domain for that Need) — a real signal, not a stored
  // "gap type" field, which doesn't exist at need-level anywhere yet.
  private buildCriticalNeeds(
    needs: Array<{
      id: string;
      title: string;
      orgId: string;
      domain: string | null;
      subDomain: string | null;
      source: string;
      referenceId: string | null;
    }>,
    orgById: Map<string, { id: string; name: string }>,
    surveyNeedIds: Array<{ id: string; needId: string }>,
    priorityAssessmentSample: Array<{
      surveyId: string;
      villageId: string;
      priorityScore: unknown;
      priorityStatus: string;
      domainComponents: unknown;
    }>,
    evidenceByNeedGroups: Array<{ needId: string; _count: number }>,
    regionIdByOrg: Map<string, string | null>,
    regionNameById: Map<string, string>,
    surveyQuestionIndicators: Array<{
      surveyId: string;
      question: { indicator: string | null; domain: string; subDomain: string } | null;
    }>,
  ): NcnpCriticalNeedsOverview {
    const needIdBySurveyId = new Map(surveyNeedIds.map((s) => [s.id, s.needId]));
    const evidenceCountByNeed = new Map(evidenceByNeedGroups.map((g) => [g.needId, g._count]));

    // Grouped by survey (not collapsed to "first found" yet) — a survey can
    // touch several indicators across several domains (e.g. a
    // village-conditions module bundling Infrastructure questions into an
    // otherwise Health survey), so which one is "this Need's indicator" has
    // to be resolved per-Need below, by matching against that Need's own
    // classified domain — not by insertion order alone, which previously let
    // an unrelated domain's question win.
    const indicatorRowsBySurveyId = new Map<string, Array<{ indicator: string; domain: string; subDomain: string }>>();
    for (const row of surveyQuestionIndicators) {
      if (!row.question?.indicator) continue;
      const list = indicatorRowsBySurveyId.get(row.surveyId) ?? [];
      list.push({ indicator: row.question.indicator, domain: row.question.domain, subDomain: row.question.subDomain });
      indicatorRowsBySurveyId.set(row.surveyId, list);
    }
    // Prefer a question matching the Need's own subDomain, then domain —
    // null (not "first found") when nothing on the survey matches the
    // Need's classification, so an unrelated domain's indicator is never
    // surfaced just because it happened to be inserted first.
    function indicatorFor(surveyId: string, needDomain: string | null, needSubDomain: string | null): string | null {
      const rows = indicatorRowsBySurveyId.get(surveyId);
      if (!rows || rows.length === 0) return null;
      const bySubDomain = needSubDomain ? rows.find((r) => r.subDomain === needSubDomain) : undefined;
      if (bySubDomain) return bySubDomain.indicator;
      const byDomain = needDomain ? rows.find((r) => r.domain === needDomain) : undefined;
      if (byDomain) return byDomain.indicator;
      return null;
    }

    interface DomainComponent {
      domainNameSnapshot?: unknown;
      domainPerformanceScore?: unknown;
      isCriticalDomain?: unknown;
      triggeredOverride?: unknown;
    }
    function primaryGapFrom(domainComponents: unknown): string | null {
      const components = Array.isArray(domainComponents) ? (domainComponents as DomainComponent[]) : [];
      let worst: { name: string; score: number } | null = null;
      for (const c of components) {
        if (typeof c.domainNameSnapshot !== 'string' || typeof c.domainPerformanceScore !== 'number') continue;
        if (!worst || c.domainPerformanceScore < worst.score) {
          worst = { name: c.domainNameSnapshot, score: c.domainPerformanceScore };
        }
      }
      return worst?.name ?? null;
    }
    // equity_flag has no stored column anywhere (see the gap analysis doc)
    // — derived the same way as primaryGap, from this same assessment's own
    // domainComponents: true when any component is both marked critical AND
    // actually triggered an override, the closest real equity-style signal
    // the v2 priority methodology already computes and stores (as JSON).
    function equityFlagFrom(domainComponents: unknown): boolean {
      const components = Array.isArray(domainComponents) ? (domainComponents as DomainComponent[]) : [];
      return components.some((c) => c.isCriticalDomain === true && c.triggeredOverride === true);
    }

    // Consolidated (villageId="") row wins when a Need's survey has one;
    // otherwise fall back to that survey's single named-village row. A
    // survey can have several named-village rows — picks the first seen
    // (sample is ordered calculatedAt desc, so effectively the latest).
    const bestAssessmentByNeedId = new Map<string, (typeof priorityAssessmentSample)[number]>();
    for (const row of priorityAssessmentSample) {
      const needId = needIdBySurveyId.get(row.surveyId);
      if (!needId) continue;
      const existing = bestAssessmentByNeedId.get(needId);
      if (!existing || (existing.villageId !== '' && row.villageId === '')) {
        bestAssessmentByNeedId.set(needId, row);
      }
    }

    const needById = new Map(needs.map((n) => [n.id, n]));
    const rows: NcnpPriorityNeedRow[] = [];
    for (const [needId, assessment] of bestAssessmentByNeedId) {
      const need = needById.get(needId);
      if (!need) continue;
      const regionId = regionIdByOrg.get(need.orgId);
      rows.push({
        needId,
        needTitle: need.title,
        domain: need.domain,
        subDomain: need.subDomain,
        organizationName: orgById.get(need.orgId)?.name ?? 'Unknown',
        priorityScore: Number(assessment.priorityScore),
        priorityStatus: assessment.priorityStatus,
        primaryGap: primaryGapFrom(assessment.domainComponents),
        evidenceCount: evidenceCountByNeed.get(needId) ?? 0,
        source: need.source,
        equityFlag: equityFlagFrom(assessment.domainComponents),
        indicatorId: indicatorFor(assessment.surveyId, need.domain, need.subDomain),
        unitGeoRegion: regionId ? (regionNameById.get(regionId) ?? null) : null,
        sourceRef: need.referenceId,
      });
    }
    // Lower priorityScore = higher priority (same convention as
    // buildPriorityOverview's village scorecard).
    rows.sort((a, b) => a.priorityScore - b.priorityScore);

    return {
      topCriticalNeeds: rows.slice(0, 3),
      priorityNeeds: rows.slice(0, PRIORITY_NEEDS_LIST_LIMIT),
      totalRankableNeeds: rows.length,
      totalNeeds: needs.length,
    };
  }

  // Always present, every count real — including all-zero when nothing has
  // happened yet (e.g. no quality assessments run), per the client's
  // "mandatory section, even if empty" requirement. Nothing here is
  // fabricated: an empty/zero result means exactly that, disclosed plainly
  // rather than omitted.
  private buildDataQualityNotes(
    totalResponses: number,
    confidenceFlagGroups: Array<{ confidenceFlag: string; _count: number }>,
    duplicateResponseCount: number,
    totalNeeds: number,
    evidenceByNeedGroups: Array<{ needId: string; _count: number }>,
    needsUnclassifiedCount: number,
  ): NcnpDataQualityNotes {
    const assessedResponses = confidenceFlagGroups.reduce((sum, g) => sum + g._count, 0);
    const lowConfidenceCount = confidenceFlagGroups.find((g) => g.confidenceFlag === 'low')?._count ?? 0;
    const needsWithEvidence = evidenceByNeedGroups.length;
    return {
      totalResponses,
      assessedResponses,
      lowConfidenceCount,
      duplicateFlaggedCount: duplicateResponseCount,
      totalNeeds,
      needsWithEvidence,
      needsWithoutEvidence: Math.max(0, totalNeeds - needsWithEvidence),
      needsUnclassified: needsUnclassifiedCount,
    };
  }

  // Which Domain shows up most in which Region — the strongest (region,
  // domain) combinations, sparse (zero-count pairs omitted) and capped, not
  // the full cross product. orgId->region is the same mapping every other
  // geography breakdown in this report already uses.
  private buildDomainRegionIntersections(
    needDomainOrgRows: Array<{ orgId: string; domain: string }>,
    regionIdByOrg: Map<string, string | null>,
    regionNameById: Map<string, string>,
  ): NcnpDomainRegionIntersection[] {
    const counts = new Map<string, { regionName: string; domainName: string; count: number }>();
    for (const row of needDomainOrgRows) {
      const regionId = regionIdByOrg.get(row.orgId);
      if (!regionId) continue;
      const regionName = regionNameById.get(regionId) ?? 'Unknown region';
      const key = `${regionId}::${row.domain}`;
      const existing = counts.get(key) ?? { regionName, domainName: row.domain, count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    }
    return Array.from(counts.values())
      .map((c) => ({ regionName: c.regionName, domainName: c.domainName, needCount: c.count }))
      .sort((a, b) => b.needCount - a.needCount)
      .slice(0, DOMAIN_REGION_INTERSECTION_LIMIT);
  }

  private assertCrossEntity(): void {
    const role = getOrgStore()?.role;
    if (!role || roleByKey(role)?.crossEntity !== true) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'Only NCNP users can view the NCNP Compiled Report.' },
      });
    }
  }
}
