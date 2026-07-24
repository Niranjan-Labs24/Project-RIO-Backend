import { Module } from "@nestjs/common";
import { MethodologyConfigModule } from "../methodology-config/methodology-config.module";
import { PriorityController, PriorityDashboardController } from "./priority.controller";
import { PriorityService } from "./priority.service";
import { DeterministicScoringService } from "./scoring.service";
import { ScoreRollupService } from "./rollup.service";
import { PriorityV2Service } from "./priority-v2.service";

@Module({
  imports: [MethodologyConfigModule],
  controllers: [PriorityController, PriorityDashboardController],
  providers: [PriorityService, DeterministicScoringService, ScoreRollupService, PriorityV2Service],
  exports: [DeterministicScoringService, ScoreRollupService, PriorityV2Service],
})
export class PriorityModule {}

