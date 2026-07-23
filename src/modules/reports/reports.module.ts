import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { MockReportApiClient } from "./providers/mock-report-api.client";
import { MockReportDataProvider } from "./providers/mock-report-data.provider";
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
    // The provider seam. To go live, swap useClass to PrismaReportDataProvider
    // — nothing else changes (generators depend on the abstract token).
    { provide: ReportDataProvider, useClass: MockReportDataProvider },
  ],
  exports: [ReportsService, ReportSummaryService, ReportDataProvider],
})
export class ReportsModule {}
