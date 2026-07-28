import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { CollectiveDashboardService } from "./collective-dashboard.service";
import type { CollectiveDashboard } from "./collective-dashboard.types";

@Controller("collective-dashboard")
export class CollectiveDashboardController {
  constructor(private readonly service: CollectiveDashboardService) {}

  @Get()
  @RequirePermission("reportsDashboards", "read")
  get(): Promise<CollectiveDashboard> {
    return this.service.get({});
  }
}
