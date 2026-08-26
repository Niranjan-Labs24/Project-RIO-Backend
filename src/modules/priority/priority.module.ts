import { Module } from "@nestjs/common";
import { MethodologyConfigModule } from "../methodology-config/methodology-config.module";
import { PriorityController, PriorityDashboardController } from "./priority.controller";
import { PriorityService } from "./priority.service";
import { DeterministicScoringService } from "./scoring.service";
import { ScoreRollupService } from "./rollup.service";
import { PriorityV2Service } from "./priority-v2.service";
import { VillageAggregationService } from "./village-aggregation.service";

@Module({
  imports: [MethodologyConfigModule],
  controllers: [PriorityController, PriorityDashboardController],
  providers: [
    PriorityService,
    DeterministicScoringService,
    ScoreRollupService,
    PriorityV2Service,
    VillageAggregationService,
  ],
  // VillageAggregationService exported so RIO-FR-008 (Sprint 3, interactive
  // village map) can import PriorityModule and inject it directly rather
  // than re-implementing the same village-level aggregation.
  exports: [DeterministicScoringService, ScoreRollupService, PriorityV2Service, VillageAggregationService],
})
export class PriorityModule {}

