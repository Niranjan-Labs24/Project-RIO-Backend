import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module';
import { SurveysModule } from '../surveys/surveys.module';
import { AiDecisionsController, AiDecisionsReviewController, AiReviewController } from './ai-decisions.controller';
import { AiDecisionsService } from './ai-decisions.service';

@Module({
  imports: [DomainsModule, SurveysModule],
  controllers: [AiDecisionsController, AiDecisionsReviewController, AiReviewController],
  providers: [AiDecisionsService],
  exports: [AiDecisionsService],
})
export class AiDecisionsModule {}
