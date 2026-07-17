import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import {
  DEFAULT_THRESHOLDS,
  scoreNeed,
  type AnsweredIndicatorQuestion,
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
      // Only Question Bank questions carry an `indicator` — open-ended/
      // additional questions have none and don't participate in the score,
      // same as the prior methodology's "open text feeds AI Summary only".
      const survey = await tx.survey.findFirst({
        where: { needId },
        include: { surveyQuestions: { include: { question: true } } },
      });
      const responses = await tx.surveyResponse.findMany({
        where: { needId, ...(surveyLinkId ? { surveyLinkId } : {}) },
      });
      const qualityRows = await tx.responseQualityResult.findMany({
        where: { needId, surveyLinkId: surveyLinkId ?? null },
      });

      const indicatorQuestions: AnsweredIndicatorQuestion[] = (survey?.surveyQuestions ?? [])
        .filter((sq) => sq.question?.indicator)
        .map((sq) => ({
          indicator: sq.question!.indicator!,
          answerType: sq.question!.answerType,
          rawAnswers: responses
            .map((r) => (r.answers as Record<string, unknown>)[sq.id])
            .filter((a) => a !== undefined && a !== null && a !== ''),
        }));

      const hasEquityFlag = this.determineEquityFlag(qualityRows);
      const result = scoreNeed(indicatorQuestions, hasEquityFlag, thresholds);

      return tx.priorityScore.create({
        data: {
          orgId,
          needId,
          studyId: need.studyId,
          surveyLinkId: surveyLinkId ?? null,
          overallScore: result.severity,
          level: result.level,
          gapType: result.gapType,
          factors: result.contributions as unknown as Prisma.InputJsonValue,
          cycleNote: result.level === "critical" || result.level === "high" ? "Acute — Cycle 1, awaiting trend" : null,
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
}
