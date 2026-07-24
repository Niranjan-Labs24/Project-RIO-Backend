import { Module } from "@nestjs/common";
import { ReviewerSlaController } from "./reviewer-sla.controller";
import { ReviewerSlaService } from "./reviewer-sla.service";

@Module({
  controllers: [ReviewerSlaController],
  providers: [ReviewerSlaService],
  exports: [ReviewerSlaService],
})
export class ReviewerSlaModule {}
