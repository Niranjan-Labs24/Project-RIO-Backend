import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { QuestionBankAlertsService } from "./question-bank-alerts.service";
import type { QuestionBankAlert } from "./question-bank-alerts.types";

@Controller("question-bank-alerts")
export class QuestionBankAlertsController {
  constructor(private readonly alerts: QuestionBankAlertsService) {}

  // Gated on `read`, not `approve` — Human Reviewer (approve) and System
  // Reviewer (read-only) both need this feed; content is identical for both,
  // same as reviewer-sla serving Approver and non-Approver off one endpoint.
  @Get()
  @RequirePermission("methodologyQuestionBank", "read")
  listAlerts(): Promise<QuestionBankAlert[]> {
    return this.alerts.listAlerts();
  }
}
