import { BadRequestException } from "@nestjs/common";
import type { ExecutiveReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT13 Executive Summary. High-level cross-scope view: top priorities, data
// quality, a structured AI narrative, anomaly flags, and reviewer notes. Study-
// scoped (requiresStudyId), so studyId is guaranteed by create()'s meta check;
// the guard here keeps the generator honest in isolation.
export async function executiveGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  if (!ctx.studyId) {
    throw new BadRequestException({
      error: { code: "STUDY_ID_REQUIRED", message: "RPT13 Executive Summary requires a studyId." },
    });
  }
  const content: ExecutiveReportContent = await ctx.provider.getExecutiveReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Executive Summary — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
