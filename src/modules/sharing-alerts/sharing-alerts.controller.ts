import { Controller, Get } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { SharingAlertsService } from "./sharing-alerts.service";
import type { SharingAlert } from "./sharing-alerts.types";

@Controller("sharing-alerts")
export class SharingAlertsController {
  constructor(private readonly sharingAlerts: SharingAlertsService) {}

  @Get()
  @RequirePermission("archiveSharingAudit", "read")
  listAlerts(): Promise<SharingAlert[]> {
    return this.sharingAlerts.listAlerts();
  }
}
