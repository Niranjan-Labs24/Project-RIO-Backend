import { Module } from "@nestjs/common";
import { ReviewerSlaController } from "./reviewer-sla.controller";
import { ReviewerSlaService } from "./reviewer-sla.service";

@Module({
  controllers: [ReviewerSlaController],
  providers: [ReviewerSlaService],
})
export class ReviewerSlaModule {}
