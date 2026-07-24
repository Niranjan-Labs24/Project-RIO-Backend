import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { ReviewerSlaService } from "./reviewer-sla.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

@Controller("reviewer-sla")
export class ReviewerSlaController {
  constructor(private readonly reviewerSla: ReviewerSlaService) {}

  @Get("config")
  // Was gated on aiReview:read — a permission the Research Officer also
  // holds (full parity on classification decisions), which leaked the
  // Approver's "surveys awaiting review" queue to them too. surveyBuilder:read
  // is what both roles that actually belong here hold — the branch inside
  // ReviewerSlaService.listAlerts decides which alerts each of them gets.
  @RequirePermission("surveyBuilder", "read")
  getConfig(): SlaConfig {
    return this.reviewerSla.getConfig();
  }

  @Get("alerts")
  // Was gated on aiReview:read — a permission the Research Officer also
  // holds (full parity on classification decisions), which leaked the
  // Approver's "surveys awaiting review" queue to them too. surveyBuilder:read
  // is what both roles that actually belong here hold — the branch inside
  // ReviewerSlaService.listAlerts decides which alerts each of them gets.
  @RequirePermission("surveyBuilder", "read")
  listAlerts(): Promise<SlaAlert[]> {
    return this.reviewerSla.listAlerts();
  }
}
