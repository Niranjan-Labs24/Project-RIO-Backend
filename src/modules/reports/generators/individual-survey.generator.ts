import { BadRequestException } from "@nestjs/common";
import type { IndividualSurveyReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT01 Individual Survey Report. ONE survey, end to end: its coverage counts,
// response funnel, severity by domain, priority, top KPIs, demographics and an
// AI narrative written against that survey alone.
//
// Survey-scoped (requiresStudyId + requiresSurveyId), so both ids are guaranteed
// by create()'s meta checks; the guards here keep the generator honest when
// called in isolation (i.e. from a test).
export async function individualSurveyGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  if (!ctx.studyId || !ctx.surveyId) {
    throw new BadRequestException({
      error: {
        code: ctx.studyId ? "SURVEY_ID_REQUIRED" : "STUDY_ID_REQUIRED",
        message: "RPT01 Individual Survey Report requires both a studyId and a surveyId.",
      },
    });
  }

  const content: IndividualSurveyReportContent = await ctx.provider.getIndividualSurveyReport({
    studyId: ctx.studyId,
    surveyId: ctx.surveyId,
    studyTitle: ctx.studyTitle,
    assessmentPeriod: ctx.assessmentPeriod,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });

  // Titled by survey, not by study — two surveys under one study must produce
  // two distinguishable rows in the reports list.
  return {
    title: `Individual Survey Report — ${content.survey.surveyTitle}`,
    content: content as unknown as Record<string, unknown>,
  };
}
