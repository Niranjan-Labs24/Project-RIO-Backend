import type { SharingStatusContent } from "../report-content.types";
import type { GeneratedReport, GeneratorCtx } from "./index";

// RPT12 Report Sharing Status. Cross-org sharing requests + a status tally.
// The real provider reads ReportSharingRequest; the mock returns representative
// rows. Org-wide (no studyId).
export async function sharingStatusGenerator(ctx: GeneratorCtx): Promise<GeneratedReport> {
  const content: SharingStatusContent = await ctx.provider.getSharingStatus({
    studyId: ctx.studyId,
    orgId: ctx.orgId,
    filters: ctx.filters,
  });
  return {
    title: "Report Sharing Status",
    content: content as unknown as Record<string, unknown>,
  };
}
