import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { PrioritySummaryController } from "./priority-summary.controller";
import { ReportSummaryService } from "./report-summary.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  controllers: [ReportsController, PrioritySummaryController],
  providers: [ReportsService, ReportSummaryService],
  exports: [ReportsService, ReportSummaryService],
})
export class ReportsModule {}
