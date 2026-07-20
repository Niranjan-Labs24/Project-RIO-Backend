import { Module } from "@nestjs/common";
import { MethodologyConfigModule } from "../methodology-config/methodology-config.module";
import { PriorityController, PriorityDashboardController } from "./priority.controller";
import { PriorityService } from "./priority.service";

@Module({
  imports: [MethodologyConfigModule],
  controllers: [PriorityController, PriorityDashboardController],
  providers: [PriorityService],
})
export class PriorityModule {}
