// What a study-scoped domain report (RPT04) actually covers.
//
// The report is described as study-wide, but every rollup query filters on ONE
// `surveyId` — the one resolveSurveyId picked. In a single-survey study those
// are the same statement; in a three-survey study they are not, and the report
// carried nothing saying which survey it had read. Rather than silently
// changing the aggregation (a scope decision for the client, not a bug fix),
// the report states its own basis and flags a partial scope.
//
// Shared by the two paths that build sector content — ReportSummaryDataProvider
// (POST /reports) and ReportSummaryService.saveToReportRepository (Insights) —
// so a report saved from either place makes the same disclosure.

import type { TenantPrismaService } from "../../../tenancy/tenant-prisma.service";
import type { SectorScopeBasis } from "../report-content.types";

export async function loadSectorScopeBasis(
  tenant: TenantPrismaService,
  input: { studyId: string; surveyId: string; explicitSurveyFilter: boolean },
): Promise<SectorScopeBasis> {
  const { studyId, surveyId, explicitSurveyFilter } = input;

  const [survey, studySurveyCount] = await Promise.all([
    tenant.runInOrgContext((tx) => tx.survey.findUnique({ where: { id: surveyId }, select: { title: true } })),
    tenant.runInOrgContext((tx) => tx.survey.count({ where: { studyId } })),
  ]);

  const surveyTitle = survey?.title ?? surveyId;
  return {
    surveyId,
    surveyTitle,
    studySurveyCount,
    resolution: explicitSurveyFilter ? "EXPLICIT_FILTER" : "LATEST_PUBLISHED",
    partialScopeNote:
      studySurveyCount > 1
        ? `This study contains ${studySurveyCount} surveys. These figures cover ONE of them — ` +
          `"${surveyTitle}" — not the study as a whole. Domain scores from the other ` +
          `${studySurveyCount - 1} survey(s) are not included in this report.`
        : null,
  };
}
