import { Module, forwardRef } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportSummaryDataProvider } from "./providers/report-summary-data.provider";
import { ReportDataProvider } from "./providers/report-data.provider";
import { PrioritySummaryController } from "./priority-summary.controller";
import { ReportSummaryService } from "./report-summary.service";
import { CombinedReportSummaryService } from "./combined-report-summary.service";
import { CombinedReportSummaryController } from "./combined-report-summary.controller";
import { AiModule } from "../ai/ai.module";
import { PriorityModule } from "../priority/priority.module";
import { ReportSharingModule } from "../report-sharing/report-sharing.module";
import { ReviewerSlaModule } from "../reviewer-sla/reviewer-sla.module";
import { SurveySessionsModule } from '../survey-sessions/survey-sessions.module';
import { NeedsModule } from '../needs/needs.module';

@Module({
  // NeedsModule exports NeedSummaryService so RPT01/RPT15 can substitute a
  // reviewer-confirmed need summary for the raw statement (RIO-AI-003).
  imports: [
    AiModule,
    PriorityModule,
    forwardRef(() => ReportSharingModule),
    ReviewerSlaModule,
    // RPT10 reads survey abandonment (see load-data-collection-completeness.ts).
    SurveySessionsModule,
    NeedsModule,
  ],
  controllers: [ReportsController, PrioritySummaryController, CombinedReportSummaryController],
  providers: [
    ReportsService,
    ReportSummaryService,
    CombinedReportSummaryService,
    { provide: ReportDataProvider, useClass: ReportSummaryDataProvider },
  ],
  exports: [ReportsService, ReportSummaryService, CombinedReportSummaryService, ReportDataProvider],
})
export class ReportsModule {}
