import { Injectable, NotFoundException } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireOrgId } from "../../tenancy/org-context";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import { assessResponseQuality, generateAiSummary } from "./response-quality.placeholder";
import type {
  AiSummary,
  AiSummaryRow,
  ResponseQualityResult,
  ResponseQualityResultRow,
} from "./response-quality.types";

@Injectable()
export class ResponseQualityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  async assess(studyId: string, surveyLinkId?: string): Promise<ResponseQualityResult[]> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const orgId = requireOrgId();
    const { confidenceFlagSettings } = await this.methodologyConfig.getRaw();

    const rows = await this.tenant.runInOrgContext(async (tx) => {
      const responses = await tx.surveyResponse.findMany({
        where: { studyId, ...(surveyLinkId ? { surveyLinkId } : {}) },
        orderBy: { submittedAt: "asc" },
      });
      const assessments = assessResponseQuality(
        responses.map((r) => ({ id: r.id, answers: r.answers as Record<string, unknown>, contact: r.contact })),
        confidenceFlagSettings,
      );
      const created = [];
      for (const assessment of assessments) {
        created.push(
          await tx.responseQualityResult.create({
            data: {
              orgId,
              studyId,
              surveyLinkId: surveyLinkId ?? null,
              surveyResponseId: assessment.surveyResponseId,
              completenessScore: assessment.completenessScore,
              missingFields: assessment.missingFields,
              confidenceFlag: assessment.confidenceFlag,
              isDuplicate: assessment.isDuplicate,
              duplicateOfId: assessment.duplicateOfId,
            },
          }),
        );
      }
      return created;
    });
    return (rows as unknown as ResponseQualityResultRow[]).map((r) => this.toResult(r));
  }

  async listForStudy(studyId: string, surveyLinkId?: string): Promise<ResponseQualityResult[]> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.responseQualityResult.findMany({
        where: { studyId, surveyLinkId: surveyLinkId ?? null },
        orderBy: { assessedAt: "desc" },
      }),
    );
    return (rows as unknown as ResponseQualityResultRow[]).map((r) => this.toResult(r));
  }

  async generateSummary(studyId: string, surveyLinkId?: string): Promise<AiSummary> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const orgId = requireOrgId();

    const row = await this.tenant.runInOrgContext(async (tx) => {
      const responses = await tx.surveyResponse.findMany({
        where: { studyId, ...(surveyLinkId ? { surveyLinkId } : {}) },
      });
      const summary = generateAiSummary(
        responses.map((r) => ({ id: r.id, answers: r.answers as Record<string, unknown>, contact: r.contact })),
      );
      return tx.aiSummary.create({
        data: {
          orgId,
          studyId,
          surveyLinkId: surveyLinkId ?? null,
          summaryText: summary.summaryText,
          responseCount: summary.responseCount,
        },
      });
    });
    return this.toSummary(row as unknown as AiSummaryRow);
  }

  async getLatestSummary(studyId: string, surveyLinkId?: string): Promise<AiSummary | null> {
    await this.findStudyOrThrow(studyId);
    if (surveyLinkId) await this.findLinkOrThrow(studyId, surveyLinkId);
    const row = await this.tenant.runInOrgContext((tx) =>
      tx.aiSummary.findFirst({ where: { studyId, surveyLinkId: surveyLinkId ?? null }, orderBy: { generatedAt: "desc" } }),
    );
    return row ? this.toSummary(row as unknown as AiSummaryRow) : null;
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

  private toResult(row: ResponseQualityResultRow): ResponseQualityResult {
    return {
      id: row.id,
      studyId: row.studyId,
      surveyLinkId: row.surveyLinkId,
      surveyResponseId: row.surveyResponseId,
      completenessScore: row.completenessScore,
      missingFields: row.missingFields,
      confidenceFlag: row.confidenceFlag,
      isDuplicate: row.isDuplicate,
      duplicateOfId: row.duplicateOfId,
      assessedAt: row.assessedAt.toISOString(),
    };
  }

  private toSummary(row: AiSummaryRow): AiSummary {
    return {
      id: row.id,
      studyId: row.studyId,
      surveyLinkId: row.surveyLinkId,
      summaryText: row.summaryText,
      responseCount: row.responseCount,
      generatedAt: row.generatedAt.toISOString(),
    };
  }
}
