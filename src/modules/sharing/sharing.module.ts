import { Module } from "@nestjs/common";
import { MailerModule } from "../../mailer/mailer.module";
import { TranslationModule } from "../translation/translation.module";
import { SharingController } from "./sharing.controller";
import { SharingService } from "./sharing.service";

@Module({
  imports: [MailerModule, TranslationModule],
  controllers: [SharingController],
  providers: [SharingService],
  exports: [SharingService],
})
export class SharingModule {}
