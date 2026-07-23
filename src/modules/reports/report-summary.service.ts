import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireOrgId, getOrgStore } from '../../tenancy/org-context';
import { AiService } from '../ai/ai.service';
import {
  PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
} from '../ai/prompts/priority-dashboard-summary.system';
import {
  VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
  VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/village-report-summary.system';
import {
  SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
  SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/sector-report-summary.system';
import {
  REGION_REPORT_SUMMARY_PROMPT_VERSION,
  REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/region-report-summary.system';
import {
  EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
  EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
} from '../ai/prompts/executive-report-summary.system';

export type SummaryScopeType = 'VILLAGE' | 'SECTOR' | 'REGION' | 'EXECUTIVE';

export interface ScopeFilters {
  villageId?: string;
  domainKey?: string;
  regionId?: string;
  villageIds?: string[];
}

export interface ReportDataSnapshot {
  snapshotId: string;
  generatedAt: string;
  scope: SummaryScopeType;
  scopeFilters: ScopeFilters;
  study: {
    studyId: string;
    studyName: string;
    surveyId: string;
    villageId: string;
    villageName: string;
    assessmentCycle: number;
    organizationName: string;
    methodologyVersionId: string;
  };
  responseQuality: {
    submittedResponseCount: number;
    validResponseCount: number;
    dontKnowRate: number;
    confidenceLevel: string;
    confidenceReason: string;
  };
  severity: {
    overallVillageNeedsIndex: number | null;
    severityBand: string;
    domainSeverityScores: Array<{
      domainKey: string;
      domainName: string;
      severityScore: number | null;
      confidenceLevel: string;
      validResponseCount: number;
    }>;
    topKpis: Array<{
      rank: number;
      kpiName: string;
      indicatorName: string;
      domainName: string;
      severityScore: number | null;
      confidenceLevel: string;
      validResponseCount: number;
    }>;
  };
  priority: {
    villagePriorityScore: number;
    priorityStatus: 'HIGH' | 'MEDIUM' | 'LOW';
    domainPerformanceScores: Array<{
      domainKey: string;
      domainName: string;
      severityScore: number;
      performanceScore: number;
      weight: number;
      weightedContribution: number;
      isCriticalDomain: boolean;
      triggeredOverride: boolean;
    }>;
    overrideApplied: boolean;
    overrideReason: string | null;
    calculatedAt: string;
  };
  evidence: Array<{
    id: string;
    evidenceTitle: string;
    type: string;
    sourceReferenceId: string;
    linkedDomainOrKpi: string;
    description: string;
    collectedDate: string;
  }>;
}

@Injectable()
export class ReportSummaryService {
  private readonly logger = new Logger(ReportSummaryService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly aiService: AiService,
  ) {}

  private getPromptForScope(scope: SummaryScopeType): { promptVersion: string; systemPrompt: string } {
    switch (scope) {
      case 'SECTOR':
        return {
          promptVersion: SECTOR_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: SECTOR_REPORT_SUMMARY_SYSTEM_PROMPT,
        };
      case 'REGION':
        return {
          promptVersion: REGION_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: REGION_REPORT_SUMMARY_SYSTEM_PROMPT,
        };
      case 'EXECUTIVE':
        return {
          promptVersion: EXECUTIVE_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: EXECUTIVE_REPORT_SUMMARY_SYSTEM_PROMPT,
        };
      case 'VILLAGE':
      default:
        return {
          promptVersion: VILLAGE_REPORT_SUMMARY_PROMPT_VERSION,
          systemPrompt: VILLAGE_REPORT_SUMMARY_SYSTEM_PROMPT,
        };
    }
  }

  /**
   * Build a frozen server-generated ReportData snapshot for Gemini.
   */
  async buildReportDataSnapshot(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
  ): Promise<{
    snapshot: ReportDataSnapshot;
    reportDataHash: string;
    evidenceHash: string;
  }> {
    const orgId = requireOrgId();
    const villageId = scopeFilters.villageId || '';

    return this.tenant.runInOrgContext(async (tx) => {
      const study = await tx.study.findUnique({
        where: { id: studyId },
        include: { org: true },
      });
      if (!study) throw new NotFoundException('Study not found');

      const survey = await tx.survey.findUnique({
        where: { id: surveyId },
      });
      if (!survey) throw new NotFoundException('Survey not found');

      const responses = await tx.surveyResponse.findMany({
        where: { needId: survey.needId },
      });

      const mv = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
      });
      if (!mv) throw new BadRequestException('No methodology version configured');

      const overallRollup = await tx.scoreRollup.findFirst({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'OVERALL',
          ...(villageId ? { villageId } : {}),
        },
      });

      let domainRollups = await tx.scoreRollup.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'DOMAIN',
          ...(villageId ? { villageId } : {}),
        },
      });

      if (scope === 'SECTOR' && scopeFilters.domainKey) {
        domainRollups = domainRollups.filter((d) => d.entityId === scopeFilters.domainKey);
      }

      const kpiRollups = await tx.scoreRollup.findMany({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          rollupLevel: 'KPI',
          ...(villageId ? { villageId } : {}),
        },
        orderBy: { severityScore: 'desc' },
        take: 10,
      });

      const priorityAssessment = await tx.villagePriorityAssessment.findFirst({
        where: {
          studyId,
          surveyId,
          methodologyVersionId: mv.id,
          ...(villageId ? { villageId } : {}),
        },
      });

      const evidenceRows = await tx.evidence.findMany({
        where: {
          studyId,
          reviewStatus: 'APPROVED',
          isIncludedInReport: true,
        },
      });

      const submittedResponseCount = responses.length;
      const validResponseCount = overallRollup?.validResponseCount ?? submittedResponseCount;
      const dontKnowRate = overallRollup ? Number(overallRollup.dontKnowRate) : 0;
      const confidenceLevel = overallRollup?.confidenceLevel ?? 'STANDARD';

      const overallNeedsIndex = overallRollup?.severityScore ? Number(overallRollup.severityScore) : null;
      const severityBand = overallNeedsIndex === null ? 'UNSCORED' : overallNeedsIndex >= 70 ? 'CRITICAL' : overallNeedsIndex >= 50 ? 'HIGH' : overallNeedsIndex >= 30 ? 'MEDIUM' : 'LOW';

      const domainComponents: any[] = (priorityAssessment?.domainComponents as any[]) || [];

      const snapshot: ReportDataSnapshot = {
        snapshotId: `snap-${Date.now()}`,
        generatedAt: new Date().toISOString(),
        scope,
        scopeFilters,
        study: {
          studyId,
          studyName: study.title,
          surveyId,
          villageId: villageId || 'ALL_VILLAGES',
          villageName: villageId || 'Consolidated Villages',
          assessmentCycle: study.cycleNumber,
          organizationName: study.org.name,
          methodologyVersionId: mv.id,
        },
        responseQuality: {
          submittedResponseCount,
          validResponseCount,
          dontKnowRate,
          confidenceLevel,
          confidenceReason: confidenceLevel === 'LOW' ? 'High rate of Don’t Know or excluded answers.' : 'High response completeness.',
        },
        severity: {
          overallVillageNeedsIndex: overallNeedsIndex,
          severityBand,
          domainSeverityScores: domainRollups.map((d) => ({
            domainKey: d.entityId,
            domainName: d.entityNameSnapshot,
            severityScore: d.severityScore ? Number(d.severityScore) : null,
            confidenceLevel: d.confidenceLevel,
            validResponseCount: d.validResponseCount,
          })),
          topKpis: kpiRollups.map((k, index) => ({
            rank: index + 1,
            kpiName: k.entityNameSnapshot,
            indicatorName: k.entityId,
            domainName: 'Core Methodology Domain',
            severityScore: k.severityScore ? Number(k.severityScore) : null,
            confidenceLevel: k.confidenceLevel,
            validResponseCount: k.validResponseCount,
          })),
        },
        priority: {
          villagePriorityScore: priorityAssessment ? Number(priorityAssessment.priorityScore) : 0,
          priorityStatus: (priorityAssessment?.priorityStatus as 'HIGH' | 'MEDIUM' | 'LOW') || 'LOW',
          domainPerformanceScores: domainComponents.map((dc) => ({
            domainKey: dc.domainKey,
            domainName: dc.domainNameSnapshot,
            severityScore: dc.domainSeverityScore,
            performanceScore: dc.domainPerformanceScore,
            weight: dc.domainWeight,
            weightedContribution: dc.weightedContribution,
            isCriticalDomain: dc.isCriticalDomain,
            triggeredOverride: dc.triggeredOverride,
          })),
          overrideApplied: priorityAssessment?.overrideApplied ?? false,
          overrideReason: priorityAssessment?.overrideReason ?? null,
          calculatedAt: priorityAssessment?.calculatedAt?.toISOString() ?? new Date().toISOString(),
        },
        evidence: evidenceRows.map((e) => ({
          id: e.id,
          evidenceTitle: e.title || e.fileName,
          type: e.fileType,
          sourceReferenceId: e.sourceReferenceId || e.id.slice(0, 8),
          linkedDomainOrKpi: e.linkedDomainOrKpi || 'General Community Evidence',
          description: e.description || 'Approved community field evidence.',
          collectedDate: e.collectedAt?.toISOString() || e.uploadedAt.toISOString(),
        })),
      };

      const reportDataHash = createHash('sha256').update(JSON.stringify(snapshot.severity) + JSON.stringify(snapshot.priority)).digest('hex');
      const evidenceHash = createHash('sha256').update(JSON.stringify(snapshot.evidence)).digest('hex');

      return { snapshot, reportDataHash, evidenceHash };
    });
  }

  /**
   * Preview included data before calling Gemini.
   */
  async previewSnapshot(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
  ) {
    return this.buildReportDataSnapshot(studyId, surveyId, scope, scopeFilters);
  }

  /**
   * Generate AI Priority Summary narrative using Gemini with scope-specific prompt.
   */
  async generatePrioritySummary(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    scopeFilters: ScopeFilters = {},
  ) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';
    const villageId = scopeFilters.villageId || '';

    const { snapshot, reportDataHash, evidenceHash } = await this.buildReportDataSnapshot(
      studyId,
      surveyId,
      scope,
      scopeFilters,
    );

    if (
      snapshot.responseQuality.submittedResponseCount === 0 ||
      snapshot.severity.overallVillageNeedsIndex === null ||
      snapshot.priority.villagePriorityScore === null
    ) {
      throw new BadRequestException(
        `Cannot generate AI Summary: No valid survey responses or scoring data available for the selected village/scope (${snapshot.study.villageName}). Please collect survey responses and calculate priority scores first.`,
      );
    }

    const { promptVersion, systemPrompt } = this.getPromptForScope(scope);
    const promptHash = createHash('sha256').update(systemPrompt).digest('hex');

    const promptText = `Generate the ${scope} SUMMARY narrative strictly using this ReportData JSON:
${JSON.stringify(snapshot, null, 2)}
`;

    const { response: aiOutputJson } = await this.aiService.generateJson<any>(
      promptText,
      systemPrompt,
      PRIORITY_DASHBOARD_SUMMARY_RESPONSE_SCHEMA,
    );

    return this.tenant.runInOrgContext(async (tx) => {
      await tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          summaryScope: scope,
          status: { in: ['DRAFT', 'STALE'] },
        },
        data: { status: 'SUPERSEDED' },
      });

      const summary = await tx.aiPrioritySummary.create({
        data: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          reportDataSnapshotId: snapshot.snapshotId,
          status: 'DRAFT',
          summaryScope: scope,
          scopeFilters: scopeFilters as any,
          promptVersion,
          promptHash,
          modelName: 'gemini-2.5-flash',
          modelVersion: 'v1',
          inputReportDataHash: reportDataHash,
          inputEvidenceSnapshotHash: evidenceHash,
          aiOutputJson,
          generatedBy: actorId,
        },
      });

      return {
        summary,
        snapshot,
      };
    });
  }

  /**
   * Fetch current active priority summary for scope.
   */
  async getSummary(
    studyId: string,
    surveyId: string,
    scope: SummaryScopeType = 'VILLAGE',
    villageId: string = '',
  ) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const summary = await tx.aiPrioritySummary.findFirst({
        where: {
          orgId,
          studyId,
          surveyId,
          villageId: villageId || '',
          summaryScope: scope,
          status: { in: ['SAVED', 'OFFICER_CONFIRMED', 'DRAFT', 'STALE'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!summary) return null;

      const filters = (summary.scopeFilters as ScopeFilters) || { villageId };
      const snapshotData = await this.buildReportDataSnapshot(studyId, surveyId, scope, filters);
      return {
        summary,
        snapshot: snapshotData.snapshot,
      };
    });
  }

  /**
   * Save Research Officer edits to summary draft.
   */
  async saveDraftEdits(summaryId: string, editedOutputJson: Record<string, unknown>) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          officerEditedOutputJson: editedOutputJson as any,
          updatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Confirm AI Priority Summary.
   */
  async confirmSummary(summaryId: string) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          status: 'OFFICER_CONFIRMED',
          officerConfirmedBy: actorId,
          officerConfirmedAt: new Date(),
        },
      });
    });
  }

  /**
   * List historical summary drafts for audit.
   */
  async getSummaryHistory(studyId: string, surveyId: string, scope: SummaryScopeType = 'VILLAGE') {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.findMany({
        where: { orgId, studyId, surveyId, summaryScope: scope },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * Invalidate active summary to STALE when scores or evidence change.
   */
  async invalidateIfStale(studyId: string, surveyId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId,
          surveyId,
          status: { in: ['DRAFT', 'OFFICER_CONFIRMED'] },
        },
        data: { status: 'STALE' },
      }),
    );
  }

  /**
   * Toggle evidence inclusion in report.
   */
  async toggleEvidenceInclusion(evidenceId: string, isIncludedInReport: boolean) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const evidence = await tx.evidence.findFirst({
        where: { id: evidenceId, orgId },
      });
      if (!evidence) throw new NotFoundException('Evidence not found');

      const updated = await tx.evidence.update({
        where: { id: evidenceId },
        data: { isIncludedInReport },
      });

      await tx.aiPrioritySummary.updateMany({
        where: {
          orgId,
          studyId: evidence.studyId,
          status: { in: ['DRAFT', 'OFFICER_CONFIRMED'] },
        },
        data: { status: 'STALE' },
      });

      return updated;
    });
  }

  /**
   * Save confirmed AI Priority Summary into the organization Reports repository.
   */
  async saveReportFromSummary(summaryId: string) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const generatedBy = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    return this.tenant.runInOrgContext(async (tx) => {
      const summary = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!summary) throw new NotFoundException('Summary not found');

      if (summary.status !== 'OFFICER_CONFIRMED') {
        throw new BadRequestException('Summary must be OFFICER_CONFIRMED before saving to report repository.');
      }

      const filters = (summary.scopeFilters as Record<string, any>) || {};
      const scopeLabel = summary.summaryScope || 'VILLAGE';
      const title = `${scopeLabel} Need Assessment Report — ${new Date().toLocaleDateString()}`;

      const report = await tx.report.create({
        data: {
          orgId,
          reportType: 'RPT13',
          title,
          studyId: summary.studyId,
          filters: filters as any,
          content: {
            summaryId: summary.id,
            scope: summary.summaryScope,
            aiOutput: summary.officerEditedOutputJson || summary.aiOutputJson,
            promptVersion: summary.promptVersion,
            confirmedAt: summary.officerConfirmedAt,
          } as any,
          generatedBy,
        },
      });

      return report;
    });
  }

  /**
   * Save a summary record explicitly into the saved summaries collection for the tenant organization.
   */
  async saveSummary(summaryId: string, editedOutputJson?: Record<string, unknown>) {
    const orgId = requireOrgId();
    const store = getOrgStore();
    const actorId = store?.actorId || '019f8dec-4f72-701c-b1a1-c1577e5dac7a';

    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.update({
        where: { id: summaryId },
        data: {
          status: 'SAVED',
          ...(editedOutputJson ? { officerEditedOutputJson: editedOutputJson as any } : {}),
          officerConfirmedBy: actorId,
          officerConfirmedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Fetch all saved summaries for the organization (multi-tenant isolated).
   */
  async getSavedSummariesList(studyId: string, surveyId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.aiPrioritySummary.findMany({
        where: {
          orgId,
          studyId,
          surveyId,
          status: { in: ['SAVED', 'OFFICER_CONFIRMED'] },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }

  /**
   * Delete a saved summary record for the organization.
   */
  async deleteSavedSummary(summaryId: string) {
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.aiPrioritySummary.findFirst({
        where: { id: summaryId, orgId },
      });
      if (!existing) throw new NotFoundException('Summary not found');

      return tx.aiPrioritySummary.delete({
        where: { id: summaryId },
      });
    });
  }
}
