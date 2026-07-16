import { Module } from '@nestjs/common';
import { AiDecisionsController, AiDecisionsReviewController } from './ai-decisions.controller';
import { AiDecisionsService } from './ai-decisions.service';

@Module({
  controllers: [AiDecisionsController, AiDecisionsReviewController],
  providers: [AiDecisionsService],
})
export class AiDecisionsModule {}
