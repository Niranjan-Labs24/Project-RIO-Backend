import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { ReviewerSlaService } from "./reviewer-sla.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

@Controller("reviewer-sla")
export class ReviewerSlaController {
  constructor(private readonly reviewerSla: ReviewerSlaService) {}

  @Get("config")
  @RequirePermission("aiReview", "read")
  getConfig(): SlaConfig {
    return this.reviewerSla.getConfig();
  }

  @Get("alerts")
  @RequirePermission("aiReview", "read")
  listAlerts(): Promise<SlaAlert[]> {
    return this.reviewerSla.listAlerts();
  }
}
