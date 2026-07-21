import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import {
  DEFAULT_THRESHOLDS,
  mapPriorityLevel,
  type ScoringThresholds,
} from "./scoring";
import type { PriorityDashboardEntry, PriorityScore, PriorityScoreRow } from "./priority.types";

@Injectable()
export class PriorityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  async score(needId: string, surveyLinkId?: string): Promise<PriorityScore> {
    const need = await this.findNeedOrThrow(needId);
    if (surveyLinkId) await this.findLinkOrThrow(needId, surveyLinkId);
    const orgId = requireOrgId();
    const thresholds = await this.loadThresholds();

    const row = await this.tenant.runInOrgContext(async (tx) => {
      // Resolve study → survey to find the OVERALL ScoreRollup written by
      // DeterministicScoringService (the real scoring engine). The old
      // scoreNeed() heuristic has been removed — severity now comes entirely
      // from the ScoringLookup-based engine.
      const survey = await tx.survey.findFirst({
        where: { needId, status: 'PUBLISHED' },
      });
      if (!survey) throw new NotFoundException({ error: { code: 'SURVEY_NOT_FOUND', message: 'No published survey found for this need.' } });

      // Determine methodology version
      const mv = await tx.methodologyVersion.findFirst({
        where: survey.methodologyVersion ? { version: survey.methodologyVersion } : { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
      });

      // Read the consolidated OVERALL rollup (villageId='') as the top-level score
      const overallRollup = mv ? await tx.scoreRollup.findFirst({
        where: {
          studyId: need.studyId,
          surveyId: survey.id,
          villageId: '',
          methodologyVersionId: mv.id,
          rollupLevel: 'OVERALL',
        }
      }) : null;

      const severity = overallRollup?.severityScore !== null && overallRollup?.severityScore !== undefined
        ? Number(overallRollup.severityScore)
        : 0;

      const qualityRows = await tx.responseQualityResult.findMany({
        where: { needId, surveyLinkId: surveyLinkId ?? null },
      });
      const hasEquityFlag = this.determineEquityFlag(qualityRows);
      const level = mapPriorityLevel(severity, hasEquityFlag, thresholds);

      return tx.priorityScore.create({
        data: {
          orgId,
          needId,
          studyId: need.studyId,
          surveyLinkId: surveyLinkId ?? null,
          overallScore: severity,
          level,
          gapType: 'acute',
          factors: (overallRollup ? {
            source: 'ScoreRollup/OVERALL',
            validResponseCount: overallRollup.validResponseCount,
            confidenceLevel: overallRollup.confidenceLevel,
          } : { source: 'no_rollup' }) as unknown as Prisma.InputJsonValue,
          cycleNote: level === 'critical' || level === 'high' ? 'Acute — Cycle 1, awaiting trend' : null,
        },
      });
    });
    return this.toScore(row as unknown as PriorityScoreRow);
  }

  // Reviewer approval gate — a Priority Score is never publicly visible
  // (dashboard/reports) until a reviewer explicitly approves it here.
  async approve(id: string): Promise<PriorityScore> {
    const approvedBy = requireActor();
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.priorityScore.update({ where: { id }, data: { approvedBy, approvedAt: new Date() } }),
    );
    return this.toScore(row as unknown as PriorityScoreRow);
  }

  // Internal/review use: shows the latest score regardless of approval
  // (with `isApproved` telling the caller which it is) — a reviewer needs
  // to see an unapproved score to be able to approve it.
  async getLatest(needId: string, surveyLinkId?: string): Promise<PriorityScore | null> {
    await this.findNeedOrThrow(needId);
    if (surveyLinkId) await this.findLinkOrThrow(needId, surveyLinkId);
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.priorityScore.findFirst({ where: { needId, surveyLinkId: surveyLinkId ?? null }, orderBy: { scoredAt: "desc" } }),
    );
    return row ? this.toScore(row as unknown as PriorityScoreRow) : null;
  }

  async listForOrg(): Promise<PriorityDashboardEntry[]> {
    // Every Need in the org, left-joined to its latest *approved* score
    // (null if unscored or still pending reviewer approval) — an unscored
    // or not-yet-approved Need must still show up here, just without a
    // score, rather than either vanishing or leaking an unapproved number.
    const { studies, needs, scores } = await this.tenant.runInOrgContext(async (tx) => ({
      studies: await tx.study.findMany(),
      needs: await tx.need.findMany({ orderBy: { updatedAt: "desc" } }),
      // Consolidated only — a dashboard row must reflect all of the Need's
      // responses, not whichever single Survey Link happened to be scored
      // most recently. Approved only — see the method comment above.
      scores: await tx.priorityScore.findMany({
        where: { surveyLinkId: null, approvedAt: { not: null } },
        orderBy: { scoredAt: "desc" },
      }),
    }));

    const studyTitleById = new Map(studies.map((s) => [s.id, s.title]));
    const latestByNeed = new Map<string, PriorityScoreRow>();
    for (const row of scores as unknown as PriorityScoreRow[]) {
      if (!latestByNeed.has(row.needId)) latestByNeed.set(row.needId, row);
    }

    return needs.map((need) => {
      const scoreRow = latestByNeed.get(need.id);
      return {
        studyId: need.studyId,
        studyTitle: studyTitleById.get(need.studyId) ?? need.studyId,
        needId: need.id,
        score: scoreRow ? this.toScore(scoreRow) : null,
      };
    });
  }

  private async loadThresholds(): Promise<ScoringThresholds> {
    try {
      const { priorityThresholds } = await this.methodologyConfig.getRaw();
      const t = priorityThresholds as Partial<Record<keyof ScoringThresholds, number>>;
      return {
        criticalSeverity: t.criticalSeverity ?? DEFAULT_THRESHOLDS.criticalSeverity,
        highSeverity: t.highSeverity ?? DEFAULT_THRESHOLDS.highSeverity,
        equityHighSeverity: t.equityHighSeverity ?? DEFAULT_THRESHOLDS.equityHighSeverity,
        mediumSeverity: t.mediumSeverity ?? DEFAULT_THRESHOLDS.mediumSeverity,
      };
    } catch {
      return DEFAULT_THRESHOLDS;
    }
  }

  // TODO(RIO-Priority): the real equity-flag determination (e.g. does this
  // gap disproportionately affect a vulnerable group?) isn't defined by the
  // methodology package yet. Placeholder: a high proportion of low-
  // confidence responses (see Response Quality) is treated as a proxy
  // signal worth flagging, not a real equity determination.
  private determineEquityFlag(qualityRows: { confidenceFlag: string }[]): boolean {
    if (qualityRows.length === 0) return false;
    const lowCount = qualityRows.filter((r) => r.confidenceFlag === "low").length;
    return lowCount / qualityRows.length >= 0.3;
  }

  private async findNeedOrThrow(needId: string) {
    const need = await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { id: needId } }));
    if (!need) throw new NotFoundException({ error: { code: "NEED_NOT_FOUND", message: "Need not found" } });
    return need;
  }

  private async findLinkOrThrow(needId: string, surveyLinkId: string): Promise<void> {
    const link = await this.tenant.runInOrgContext((tx) => tx.publicSurveyLink.findUnique({ where: { id: surveyLinkId } }));
    if (!link || link.needId !== needId) {
      throw new NotFoundException({ error: { code: "SURVEY_LINK_NOT_FOUND", message: "Survey link not found" } });
    }
  }

  private toScore(row: PriorityScoreRow): PriorityScore {
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      surveyLinkId: row.surveyLinkId,
      overallScore: row.overallScore,
      level: row.level,
      gapType: row.gapType,
      factors: row.factors as PriorityScore["factors"],
      cycleNote: row.cycleNote,
      scoredAt: row.scoredAt.toISOString(),
      isApproved: row.approvedAt !== null,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    };
  }

  // --- Severity Scoring v1 Endpoints ---

  async listMethodologyVersions(): Promise<any[]> {
    return this.tenant.runAsSupervisor((tx) =>
      tx.methodologyVersion.findMany({
        orderBy: { createdAt: "desc" },
      })
    );
  }

  async createMethodologyVersion(payload: { name: string; version: string; description?: string }): Promise<any> {
    const actorId = requireActor();
    return this.tenant.runAsSupervisor((tx) =>
      tx.methodologyVersion.create({
        data: {
          name: payload.name,
          version: payload.version,
          description: payload.description || null,
          createdBy: actorId,
        }
      })
    );
  }

  async uploadLookups(versionId: string, csvContent: string): Promise<any> {
    const lines = csvContent.split(/\r?\n/);
    let imported = 0;
    
    // Validate methodology version exists
    const mv = await this.tenant.runAsSupervisor((tx) =>
      tx.methodologyVersion.findUnique({ where: { id: versionId } })
    );
    if (!mv) {
      throw new NotFoundException({ error: { code: 'METHODOLOGY_NOT_FOUND', message: 'Methodology version not found' } });
    }

    await this.tenant.runAsSupervisor(async (tx) => {
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;

        const cols = this.parseCsvRow(line);
        // columns format: methodologyVersion,questionId,lookupType,optionId,optionOrder,severityScore,numericFloor,numericCeiling,severityDirection,isExcluded,exclusionReason
        const qId = cols[1];
        const lookupType = cols[2];
        const optionId = cols[3] || null;
        const optionOrderStr = cols[4];
        const severityScoreStr = cols[5];
        const numericFloorStr = cols[6];
        const numericCeilingStr = cols[7];
        const severityDirection = cols[8] || null;
        const isExcludedStr = cols[9];
        const exclusionReason = cols[10] || null;

        if (!qId || !lookupType) continue;

        const optionOrder = optionOrderStr ? parseInt(optionOrderStr, 10) : null;
        const severityScore = severityScoreStr ? parseFloat(severityScoreStr) : null;
        const numericFloor = numericFloorStr ? parseFloat(numericFloorStr) : null;
        const numericCeiling = numericCeilingStr ? parseFloat(numericCeilingStr) : null;
        const isExcluded = isExcludedStr?.toLowerCase() === 'true';

        // Check and upsert
        const existing = await tx.scoringLookup.findFirst({
          where: {
            methodologyVersionId: versionId,
            questionId: qId,
            lookupType,
            optionId,
          }
        });

        if (existing) {
          await tx.scoringLookup.update({
            where: { id: existing.id },
            data: {
              optionOrder,
              severityScore,
              numericFloor,
              numericCeiling,
              severityDirection,
              isExcluded,
              exclusionReason,
            }
          });
        } else {
          await tx.scoringLookup.create({
            data: {
              methodologyVersionId: versionId,
              questionId: qId,
              lookupType,
              optionId,
              optionOrder,
              severityScore,
              numericFloor,
              numericCeiling,
              severityDirection,
              isExcluded,
              exclusionReason,
            }
          });
        }
        imported++;
      }
    });

    return { imported };
  }

  private parseCsvRow(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  async getDashboard(studyId: string, surveyId: string, villageId: string | null): Promise<any> {
    const vId = villageId || '';
    return this.tenant.runInOrgContext(async (tx) => {
      // Find overall index
      const overall = await tx.scoreRollup.findFirst({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'OVERALL' }
      });

      // Find all domain rollups
      const domains = await tx.scoreRollup.findMany({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'DOMAIN' }
      });

      const subDomains = await tx.scoreRollup.findMany({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'SUB_DOMAIN' }
      });

      const indicators = await tx.scoreRollup.findMany({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'INDICATOR' }
      });

      const kpis = await tx.scoreRollup.findMany({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'KPI' }
      });

      // Get methodology version name
      const survey = await tx.survey.findUnique({ where: { id: surveyId } });
      const version = survey?.methodologyVersion || 'v1.0';

      return {
        overall: overall ? {
          severityScore: overall.severityScore !== null ? Number(overall.severityScore) : null,
          confidenceLevel: overall.confidenceLevel,
          validResponseCount: overall.validResponseCount,
          dontKnowRate: Number(overall.dontKnowRate),
        } : null,
        domains: domains.map(d => ({
          id: d.entityId,
          name: d.entityNameSnapshot,
          severityScore: d.severityScore !== null ? Number(d.severityScore) : null,
          confidenceLevel: d.confidenceLevel,
          validResponseCount: d.validResponseCount,
        })),
        subDomains: subDomains.map(d => ({
          id: d.entityId,
          name: d.entityNameSnapshot,
          severityScore: d.severityScore !== null ? Number(d.severityScore) : null,
          confidenceLevel: d.confidenceLevel,
        })),
        indicators: indicators.map(d => ({
          id: d.entityId,
          name: d.entityNameSnapshot,
          severityScore: d.severityScore !== null ? Number(d.severityScore) : null,
          confidenceLevel: d.confidenceLevel,
        })),
        kpis: kpis.map(d => ({
          id: d.entityId,
          name: d.entityNameSnapshot,
          severityScore: d.severityScore !== null ? Number(d.severityScore) : null,
          confidenceLevel: d.confidenceLevel,
        })),
        methodologyVersion: version,
      };
    });
  }

  async getKpiRanking(studyId: string, surveyId: string, villageId: string | null): Promise<any[]> {
    const vId = villageId || '';
    return this.tenant.runInOrgContext(async (tx) => {
      const rollups = await tx.scoreRollup.findMany({
        where: { studyId, surveyId, villageId: vId, rollupLevel: 'KPI' },
        orderBy: { severityScore: { sort: 'desc', nulls: 'last' } }
      });

      // Get mappings of KPI -> domain, sub-domain, indicator
      const questions = await tx.question.findMany({ where: { usedInMvp: true } });
      const qMap = new Map<string, any>();
      for (const q of questions) {
        if (q.kpi && !qMap.has(q.kpi)) {
          qMap.set(q.kpi, q);
        }
      }

      return rollups.map((r, idx) => {
        const mapping = qMap.get(r.entityId);
        return {
          rank: idx + 1,
          kpi: r.entityId,
          indicator: mapping?.indicator || '',
          subDomain: mapping?.subDomain || '',
          domain: mapping?.domain || '',
          severityScore: r.severityScore !== null ? Number(r.severityScore) : null,
          validResponseCount: r.validResponseCount,
          dontKnowRate: Number(r.dontKnowRate),
          confidenceLevel: r.confidenceLevel,
        };
      });
    });
  }

  async getQuestionDetail(studyId: string, surveyId: string, questionId: string, villageId: string | null): Promise<any> {
    const vId = villageId || '';
    return this.tenant.runInOrgContext(async (tx) => {
      // Find question — supports both direct questionId (e.g. "H01") and
      // KPI name strings (e.g. "Water Source Reliability") passed from the
      // KPI ranking table which stores KPI names as entityIds.
      let question = await tx.question.findUnique({ where: { questionId } });
      if (!question) {
        // Try resolving by KPI name: find the first scoreable question in this KPI
        question = await tx.question.findFirst({
          where: { kpi: questionId, usedInMvp: true },
          orderBy: { questionId: 'asc' },
        });
      }
      if (!question) {
        throw new NotFoundException({ error: { code: 'QUESTION_NOT_FOUND', message: `No question found for id or kpi: ${questionId}` } });
      }

      // Find methodology version used by the survey
      const surveyObj = await tx.survey.findUnique({ where: { id: surveyId } });
      const version = surveyObj?.methodologyVersion || 'v1.0';
      const mv = await tx.methodologyVersion.findUnique({ where: { version } });

      // Find question rollup
      const rollup = await tx.scoreRollup.findUnique({
        where: {
          studyId_surveyId_villageId_methodologyVersionId_rollupLevel_entityId: {
            studyId,
            surveyId,
            villageId: vId,
            methodologyVersionId: mv?.id || '',
            rollupLevel: 'QUESTION',
            entityId: questionId,
          }
        }
      });

      // Find all response answers for this question
      const answers = await tx.responseAnswer.findMany({
        where: {
          studyId,
          surveyId,
          questionId,
          ...(villageId !== null ? { villageId } : {})
        }
      });

      // Group option counts
      const countsMap = new Map<string, number>();
      let missingAnswerCount = 0;
      for (const a of answers) {
        if (a.answerOptionId) {
          countsMap.set(a.answerOptionId, (countsMap.get(a.answerOptionId) || 0) + 1);
        } else if (a.answerOptionIds && Array.isArray(a.answerOptionIds)) {
          const opts = a.answerOptionIds as unknown as string[];
          for (const opt of opts) {
            countsMap.set(opt, (countsMap.get(opt) || 0) + 1);
          }
        } else if (a.answerNumericValue !== null) {
          const numStr = String(a.answerNumericValue);
          countsMap.set(numStr, (countsMap.get(numStr) || 0) + 1);
        } else if (a.answerText) {
          countsMap.set(a.answerText, (countsMap.get(a.answerText) || 0) + 1);
        } else {
          missingAnswerCount++;
        }
      }

      const optionsList = Array.isArray(question.answerOptions)
        ? (question.answerOptions as string[]).map(opt => {
            const cleanOptId = opt.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
            return {
              optionId: cleanOptId,
              label: opt,
              count: countsMap.get(cleanOptId) || 0,
            };
          })
        : Array.from(countsMap.entries()).map(([opt, count]) => ({
            optionId: opt,
            label: opt,
            count,
          }));

      const matchLookups = mv ? await tx.scoringLookup.findMany({
        where: { methodologyVersionId: mv.id, questionId }
      }) : [];

      const lookups = matchLookups.map(l => ({
        optionId: l.optionId,
        lookupType: l.lookupType,
        severityScore: l.severityScore !== null ? Number(l.severityScore) : null,
        isExcluded: l.isExcluded,
        exclusionReason: l.exclusionReason,
      }));

      return {
        questionId: question.questionId,
        questionText: question.questionText,
        isScoreable: question.isScoreable,
        domain: question.domain,
        subDomain: question.subDomain,
        kpi: question.kpi,
        indicator: question.indicator,
        averageSeverity: rollup?.severityScore !== null ? Number(rollup?.severityScore) : null,
        validCount: rollup?.validResponseCount || 0,
        excludedCount: rollup?.excludedResponseCount || 0,
        dontKnowCount: rollup?.dontKnowCount || 0,
        notApplicableCount: rollup?.notApplicableCount || 0,
        methodologyVersion: version,
        optionsDistribution: optionsList,
        lookups,
        calculatedAt: rollup?.calculatedAt?.toISOString() || new Date().toISOString(),
      };
    });
  }
}
