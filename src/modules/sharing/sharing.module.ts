import { Module } from "@nestjs/common";
import { MailerModule } from "../../mailer/mailer.module";
import { TranslationModule } from "../translation/translation.module";
import { ReportsModule } from "../reports/reports.module";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

@Module({
  // ReportsModule: UAT SHR-04 — a shared study's released reports.
  imports: [MailerModule, TranslationModule, ReportsModule],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
