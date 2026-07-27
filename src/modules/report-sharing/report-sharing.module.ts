import { Module, forwardRef } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { ReportSharingController } from "./report-sharing.controller";
import { ReportSharingService } from "./report-sharing.service";

@Module({
  // Mutual: ReportsModule needs ReportSharingService for RPT12 Sharing Status.
  imports: [forwardRef(() => ReportsModule)],
  controllers: [ReportSharingController],
  providers: [ReportSharingService],
  exports: [ReportSharingService],
})
export class ReportSharingModule {}
