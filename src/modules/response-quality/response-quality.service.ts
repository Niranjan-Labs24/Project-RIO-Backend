import { Injectable, NotFoundException } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { requireOrgId } from "../../tenancy/org-context";
import { MethodologyConfigService } from "../methodology-config/methodology-config.service";
import { assessResponseQuality } from "./response-quality.placeholder";
import type {
  ResponseQualityResult,
  ResponseQualityResultRow,
} from "./response-quality.types";

@Injectable()
export class ResponseQualityService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methodologyConfig: MethodologyConfigService,
  ) {}

  async assess(needId: string, surveyLinkId?: string): Promise<ResponseQualityResult[]> {
    const need = await this.findNeedOrThrow(needId);
    if (surveyLinkId) await this.findLinkOrThrow(needId, surveyLinkId);
    const orgId = requireOrgId();
    const { confidenceFlagSettings } = await this.methodologyConfig.getRaw();

    const rows = await this.tenant.runInOrgContext(async (tx) => {
      const responses = await tx.surveyResponse.findMany({
        where: { needId, ...(surveyLinkId ? { surveyLinkId } : {}) },
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
              needId,
              studyId: need.studyId,
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

  async listForNeed(needId: string, surveyLinkId?: string): Promise<ResponseQualityResult[]> {
    await this.findNeedOrThrow(needId);
    if (surveyLinkId) await this.findLinkOrThrow(needId, surveyLinkId);
    const rows = await this.tenant.runRead((tx) =>
      tx.responseQualityResult.findMany({
        where: { needId, surveyLinkId: surveyLinkId ?? null },
        orderBy: { assessedAt: "desc" },
      }),
    );
    return (rows as unknown as ResponseQualityResultRow[]).map((r) => this.toResult(r));
  }

  private async findNeedOrThrow(needId: string) {
    const need = await this.tenant.runRead((tx) => tx.need.findUnique({ where: { id: needId } }));
    if (!need) throw new NotFoundException({ error: { code: "NEED_NOT_FOUND", message: "Need not found" } });
    return need;
  }

  private async findLinkOrThrow(needId: string, surveyLinkId: string): Promise<void> {
    const link = await this.tenant.runRead((tx) => tx.publicSurveyLink.findUnique({ where: { id: surveyLinkId } }));
    if (!link || link.needId !== needId) {
      throw new NotFoundException({ error: { code: "SURVEY_LINK_NOT_FOUND", message: "Survey link not found" } });
    }
  }

  private toResult(row: ResponseQualityResultRow): ResponseQualityResult {
    return {
      id: row.id,
      needId: row.needId,
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
}
