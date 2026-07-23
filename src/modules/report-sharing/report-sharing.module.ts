import { Module } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { ReportSharingController } from "./report-sharing.controller";
import { ReportSharingService } from "./report-sharing.service";

@Module({
  imports: [ReportsModule],
  controllers: [ReportSharingController],
  providers: [ReportSharingService],
  exports: [ReportSharingService],
})
export class ReportSharingModule {}
