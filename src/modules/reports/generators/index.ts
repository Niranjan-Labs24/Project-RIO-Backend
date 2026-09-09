import type { ReportDataProvider } from "../providers/report-data.provider";

// Generator seam. Each core report is a small pure function that formats and
// titles the content the provider supplies. Generators receive the PROVIDER,
// never a raw prisma tx — they must not know where the data came from.
//
// ONE documented exception: evidence-reports.generator.ts (RPT16/RPT17) is
// handed an open transaction, because its evidence-document, geography and
// snapshot reads have no ReportDataProvider method behind them yet. That is
// not a new hole — the pair was assembled inline inside ReportsService before,
// which is not behind the seam either; extracting it moved the code without
// widening the exception. Giving the provider a getCombinedEvidenceReport /
// getEvidenceDocumentReport pair and reducing that generator to the same
// twenty lines as its neighbours is the follow-up that closes it.
export interface GeneratorCtx {
  provider: ReportDataProvider;
  orgId: string;
  studyId?: string;
  // Set only for survey-scoped types (RPT01/RPT15). ReportsService.create has
  // already validated that it exists and belongs to studyId.
  surveyId?: string;
  // Resolved study details (when studyId is set) so reports show real study
  // metadata, not generic labels — passed through to the provider query.
  studyTitle?: string;
  assessmentCycle?: number;
  assessmentPeriod?: string;
  filters: Record<string, unknown>;
}

export interface GeneratedReport {
  title: string;
  content: Record<string, unknown>;
}

export type ReportGenerator = (ctx: GeneratorCtx) => Promise<GeneratedReport>;
