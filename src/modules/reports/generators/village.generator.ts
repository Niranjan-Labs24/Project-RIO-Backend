import { BadRequestException } from "@nestjs/common";
import type { VillageReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT14 Village Report. Thin by design: resolve the village, ask the provider
// for the content (mock now, real analytics later), title it. All the data —
// severity, priority, the critical-domain override, KPIs, AI summary — comes
// from ctx.provider.getVillageReport(); the generator never computes a number.
// That's what makes the report reconcile with the Village Priority dashboard:
// the real provider selects the same analytics rows the dashboard reads.
export async function villageGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  if (!ctx.studyId) {
    throw new BadRequestException({
      error: { code: "STUDY_ID_REQUIRED", message: "RPT14 Village Report requires a studyId." },
    });
  }
  const villageId = typeof ctx.filters.villageId === "string" ? ctx.filters.villageId.trim() : "";
  if (!villageId) {
    throw new BadRequestException({
      error: { code: "VILLAGE_ID_REQUIRED", message: "Village Report requires filters.villageId." },
    });
  }

  const content: VillageReportContent = await ctx.provider.getVillageReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    assessmentCycle: ctx.assessmentCycle,
    assessmentPeriod: ctx.assessmentPeriod,
    villageId,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });

  return {
    title: `Village Report — ${content.village.name}`,
    content: content as unknown as Record<string, unknown>,
  };
}
