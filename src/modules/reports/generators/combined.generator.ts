import { BadRequestException } from "@nestjs/common";
import type { CombinedReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT15 Survey & Dashboard Report. One survey's results merged with the
// organisation's dashboard outputs, plus the comparison band that relates them.
//
// The provider guarantees the reconciliation property (survey half from one
// snapshot, dashboard half from one aggregate call) — this generator only names
// and shapes the result.
export async function combinedGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  if (!ctx.studyId || !ctx.surveyId) {
    throw new BadRequestException({
      error: {
        code: ctx.studyId ? "SURVEY_ID_REQUIRED" : "STUDY_ID_REQUIRED",
        message: "RPT15 Survey & Dashboard Report requires both a studyId and a surveyId.",
      },
    });
  }

  const content: CombinedReportContent = await ctx.provider.getCombinedReport({
    studyId: ctx.studyId,
    surveyId: ctx.surveyId,
    studyTitle: ctx.studyTitle,
    assessmentPeriod: ctx.assessmentPeriod,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });

  return {
    title: `Survey & Dashboard Report — ${content.survey.surveyTitle}`,
    content: content as unknown as Record<string, unknown>,
  };
}
