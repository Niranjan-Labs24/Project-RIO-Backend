import { Module, forwardRef } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { MailerModule } from "../../mailer/mailer.module";
import { TranslationModule } from "../translation/translation.module";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

@Module({
  imports: [MailerModule, TranslationModule, forwardRef(() => ReportsModule)],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
