import { Module, forwardRef } from "@nestjs/common";
import { MailerModule } from "../../mailer/mailer.module";
import { TranslationModule } from "../translation/translation.module";
import { ReportsModule } from "../reports/reports.module";
import { ReportSharingController } from "./report-sharing.controller";
import { ReportSharingService } from "./report-sharing.service";

@Module({
  // Mutual: ReportsModule needs ReportSharingService for RPT12 Sharing Status.
  imports: [forwardRef(() => ReportsModule), MailerModule, TranslationModule],
  controllers: [ReportSharingController],
  providers: [ReportSharingService],
  exports: [ReportSharingService],
})
export class ReportSharingModule {}
