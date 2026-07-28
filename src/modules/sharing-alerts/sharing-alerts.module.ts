import { Module } from "@nestjs/common";
import { SharingModule } from "../sharing/sharing.module";
import { ReportSharingModule } from "../report-sharing/report-sharing.module";
import { SharingAlertsController } from "./sharing-alerts.controller";
import { SharingAlertsService } from "./sharing-alerts.service";

@Module({
  imports: [SharingModule, ReportSharingModule],
  controllers: [SharingAlertsController],
  providers: [SharingAlertsService],
})
export class SharingAlertsModule {}
