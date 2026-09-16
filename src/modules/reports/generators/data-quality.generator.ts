import type { DataQualityReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT10 Data-Quality Report — completeness, confidence and exclusion flags for
// the data every other report rests on.
//
// Acceptance criterion 6 is the design constraint here: this report FLAGS
// incomplete or unreviewed records, it never silently excludes them. Every
// count it reports has an itemised list behind it (see `flaggedRecords`), and
// data-quality.generator.spec.ts asserts that the two agree — a count without
// its rows is exactly the "silent exclusion" the criterion prohibits.
//
// Study-scoped, sharing the unified pipeline with RPT01 and RPT03 so the
// quality figures shown here are the ones that produced the scores elsewhere.
export async function dataQualityGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: DataQualityReportContent = await ctx.provider.getDataQualityReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Data-Quality Report — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
