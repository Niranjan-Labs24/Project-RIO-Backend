import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { MockReportApiClient } from "./providers/mock-report-api.client";
import { MockReportDataProvider } from "./providers/mock-report-data.provider";
import { ReportSummaryDataProvider } from "./providers/report-summary-data.provider";
import { ReportDataProvider } from "./providers/report-data.provider";
import { PrioritySummaryController } from "./priority-summary.controller";
import { ReportSummaryService } from "./report-summary.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  controllers: [ReportsController, PrioritySummaryController],
  providers: [
    ReportsService, ReportSummaryService,
    MockReportApiClient,
    // Concrete mock provider — now the fallback for un-scored studies and
    // cross-study aggregates, injected into the real provider below.
    MockReportDataProvider,
    // The provider seam is now bound to REAL data (ReportSummaryService: DB
    // snapshot + Gemini summary + survey demographics), falling back to the
    // mock only when a study isn't scored yet.
    { provide: ReportDataProvider, useClass: ReportSummaryDataProvider },
  ],
  exports: [ReportsService, ReportSummaryService, ReportDataProvider],
})
export class ReportsModule {}
