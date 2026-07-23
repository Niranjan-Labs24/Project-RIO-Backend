import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { MockReportApiClient } from "./providers/mock-report-api.client";
import { MockReportDataProvider } from "./providers/mock-report-data.provider";
import { ReportDataProvider } from "./providers/report-data.provider";

@Module({
  controllers: [ReportsController],
  providers: [
    ReportsService,
    MockReportApiClient,
    // The provider seam. To go live, swap useClass to PrismaReportDataProvider
    // — nothing else changes (generators depend on the abstract token).
    { provide: ReportDataProvider, useClass: MockReportDataProvider },
  ],
  exports: [ReportsService, ReportDataProvider],
})
export class ReportsModule {}
