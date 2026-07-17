import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireOrgId } from "../../tenancy/org-context";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import { scorePriority } from "./priority.placeholder";
import type { PriorityDashboardEntry, PriorityScore, PriorityScoreRow } from "./priority.types";

@Injectable()
export class PriorityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  async score(studyId: string, surveyLinkId?: string): Promise<PriorityScore> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const orgId = requireOrgId();
    const { priorityThresholds, priorityFactorWeights } = await this.methodologyConfig.getRaw();

    const row = await this.tenant.runInOrgContext(async (tx) => {
      const responseCount = await tx.surveyResponse.count({
        where: { studyId, ...(surveyLinkId ? { surveyLinkId } : {}) },
      });
      const qualityRows = await tx.responseQualityResult.findMany({
        where: { studyId, surveyLinkId: surveyLinkId ?? null },
      });
      const averageCompleteness =
        qualityRows.length === 0
          ? 100
          : Math.round(qualityRows.reduce((sum, r) => sum + r.completenessScore, 0) / qualityRows.length);

      // Not response-scoped — an AI Decision belongs to the Study as a
      // whole, not to any one Survey Link, so it stays consolidated
      // regardless of the selected scope.
      const latestDecision = await tx.aiDecision.findFirst({
        where: { studyId, touchpoint: "need_classification" },
        orderBy: { createdAt: "desc" },
      });
      const suggestion = latestDecision?.suggestion as { domains?: string[] } | undefined;
      const domainCode = suggestion?.domains?.[0] ?? null;

      const result = scorePriority({
        responseCount, averageCompleteness, domainCode,
        thresholds: priorityThresholds, factorWeights: priorityFactorWeights,
      });

      return tx.priorityScore.create({
        data: {
          orgId,
          studyId,
          surveyLinkId: surveyLinkId ?? null,
          overallScore: result.overallScore,
          level: result.level,
          gapType: result.gapType,
          factors: result.factors as unknown as Prisma.InputJsonValue,
          cycleNote: result.cycleNote,
        },
      });
    });
    return this.toScore(row as unknown as PriorityScoreRow);
  }

  async getLatest(studyId: string, surveyLinkId?: string): Promise<PriorityScore | null> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.priorityScore.findFirst({ where: { studyId, surveyLinkId: surveyLinkId ?? null }, orderBy: { scoredAt: "desc" } }),
    );
    return row ? this.toScore(row as unknown as PriorityScoreRow) : null;
  }

  async listForOrg(): Promise<PriorityDashboardEntry[]> {
    // Every study in the org, left-joined to its latest score (null if it
    // hasn't been run yet) — a study that was never scored must still show
    // up here, just as "not scored yet", rather than silently vanishing
    // (the previous version only ever listed rows that already had a
    // PriorityScore, which hid every unscored study).
    const { studies, scores } = await this.tenant.runInOrgContext(async (tx) => ({
      studies: await tx.study.findMany({ orderBy: { updatedAt: "desc" } }),
      // Consolidated only — a Study-level dashboard row must reflect all of
      // its responses, not whichever single Survey Link happened to be
      // scored most recently.
      scores: await tx.priorityScore.findMany({ where: { surveyLinkId: null }, orderBy: { scoredAt: "desc" } }),
    }));

    const latestByStudy = new Map<string, PriorityScoreRow>();
    for (const row of scores as unknown as PriorityScoreRow[]) {
      if (!latestByStudy.has(row.studyId)) latestByStudy.set(row.studyId, row);
    }

    return studies.map((study) => {
      const scoreRow = latestByStudy.get(study.id);
      return {
        studyId: study.id,
        studyTitle: study.title,
        studyStatus: study.status,
        score: scoreRow ? this.toScore(scoreRow) : null,
      };
    });
  }

  private async findStudyOrThrow(studyId: string): Promise<void> {
    const study = await this.tenant.runInOrgContext((tx) => tx.study.findUnique({ where: { id: studyId } }));
    if (!study) throw new NotFoundException({ error: { code: "STUDY_NOT_FOUND", message: "Study not found" } });
  }

  private async findLinkOrThrow(studyId: string, surveyLinkId: string): Promise<void> {
    const link = await this.tenant.runInOrgContext((tx) => tx.publicSurveyLink.findUnique({ where: { id: surveyLinkId } }));
    if (!link || link.studyId !== studyId) {
      throw new NotFoundException({ error: { code: "SURVEY_LINK_NOT_FOUND", message: "Survey link not found" } });
    }
  }

  private toScore(row: PriorityScoreRow): PriorityScore {
    return {
      id: row.id,
      studyId: row.studyId,
      surveyLinkId: row.surveyLinkId,
      overallScore: row.overallScore,
      level: row.level,
      gapType: row.gapType,
      factors: row.factors as PriorityScore["factors"],
      cycleNote: row.cycleNote,
      scoredAt: row.scoredAt.toISOString(),
      isPlaceholder: true,
    };
  }
}
