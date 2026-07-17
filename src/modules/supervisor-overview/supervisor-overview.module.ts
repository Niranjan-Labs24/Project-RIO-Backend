import { Module } from "@nestjs/common";
import { SupervisorOverviewController } from "./supervisor-overview.controller";
import { SupervisorOverviewService } from "./supervisor-overview.service";

@Module({
  controllers: [SupervisorOverviewController],
  providers: [SupervisorOverviewService],
})
export class SupervisorOverviewModule {}
