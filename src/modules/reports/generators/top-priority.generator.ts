import type { TopPriorityReportContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT03 / RPT09 Top-Priority Report — the ranked list of the highest-priority
// needs produced by the scoring engine (RIO-FR-003), with the score components
// printed alongside so the ranking is reproducible by a reader rather than
// taken on trust. That is the methodology's explainability requirement, not a
// nicety: "the components of every score are displayed".
//
// Same seam rule as the other core generators — the provider selects the same
// rows the Priority dashboard reads, so the report reconciles with it.
// Study-scoped.
export async function topPriorityGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: TopPriorityReportContent = await ctx.provider.getTopPriorityReport({
    studyId: ctx.studyId,
    studyTitle: ctx.studyTitle,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: `Top-Priority Report — ${content.header.studyName}`,
    content: content as unknown as Record<string, unknown>,
  };
}
