import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { SupervisorOverviewService } from "./supervisor-overview.service";
import type { SupervisorOverview } from "./supervisor-overview.types";

@Controller("supervisor-overview")
export class SupervisorOverviewController {
  constructor(private readonly overview: SupervisorOverviewService) {}

  @Get()
  @RequirePermission("archiveSharingAudit", "read")
  get(): Promise<SupervisorOverview> {
    return this.overview.getOverview();
  }
}
