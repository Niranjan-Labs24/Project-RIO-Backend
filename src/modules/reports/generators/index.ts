import type { ReportDataProvider } from "../providers/report-data.provider";

// Generator seam. Each core report is a small pure function that formats and
// titles the content the provider supplies. Generators receive the PROVIDER,
// never a raw prisma tx — they must not know whether data is mock or real.
export interface GeneratorCtx {
  provider: ReportDataProvider;
  orgId: string;
  studyId?: string;
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
