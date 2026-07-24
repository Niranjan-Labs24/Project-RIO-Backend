import { Module } from "@nestjs/common";
import { ReportsModule } from "../reports/reports.module";
import { ReviewerSlaModule } from "../reviewer-sla/reviewer-sla.module";
import { CollectiveDashboardController } from "./collective-dashboard.controller";
import { CollectiveDashboardService } from "./collective-dashboard.service";

@Module({
  imports: [ReportsModule, ReviewerSlaModule],
  controllers: [CollectiveDashboardController],
  providers: [CollectiveDashboardService],
})
export class CollectiveDashboardModule {}
