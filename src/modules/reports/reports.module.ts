import { Module, forwardRef } from "@nestjs/common";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportSummaryDataProvider } from "./providers/report-summary-data.provider";
import { ReportDataProvider } from "./providers/report-data.provider";
import { PrioritySummaryController } from "./priority-summary.controller";
import { ReportSummaryService } from "./report-summary.service";
import { AiModule } from "../ai/ai.module";
import { PriorityModule } from "../priority/priority.module";
import { ReportSharingModule } from "../report-sharing/report-sharing.module";
import { ReviewerSlaModule } from "../reviewer-sla/reviewer-sla.module";

@Module({
  // PriorityModule exports PriorityV2Service — the authoritative org-wide
  // priority rows the collective dashboard aggregates (reconciles with the
  // Priority Dashboard).
  // ReportSharingModule (RPT12 rows) imports this module back, hence the
  // forwardRef on both sides. ReviewerSlaModule (RPT02's SLA figure) has no
  // imports, so it needs none.
  imports: [AiModule, PriorityModule, forwardRef(() => ReportSharingModule), ReviewerSlaModule],
  controllers: [ReportsController, PrioritySummaryController],
  providers: [
    ReportsService, ReportSummaryService,
    // The provider seam is bound to REAL data throughout: DB snapshot + Gemini
    // summary + survey demographics per scope, real priority/sharing/SLA rows
    // for the cross-study reports. There is no mock fallback — an un-scored
    // study raises STUDY_NOT_SCORED (409) rather than returning fixtures.
    { provide: ReportDataProvider, useClass: ReportSummaryDataProvider },
  ],
  exports: [ReportsService, ReportSummaryService, ReportDataProvider],
})
export class ReportsModule {}
