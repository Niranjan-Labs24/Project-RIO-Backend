import { Module } from "@nestjs/common";
import { QuestionBankAlertsService } from "./question-bank-alerts.service";
import { QuestionBankAlertsController } from "./question-bank-alerts.controller";

@Module({
  controllers: [QuestionBankAlertsController],
  providers: [QuestionBankAlertsService],
})
export class QuestionBankAlertsModule {}
