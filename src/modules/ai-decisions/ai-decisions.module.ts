import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module';
import { MethodologyConfigModule } from '../methodology-config/methodology-config.module';
import { SurveysModule } from '../surveys/surveys.module';
import { AiDecisionsController, AiDecisionsReviewController, AiReviewController } from './ai-decisions.controller';
import { AiDecisionsService } from './ai-decisions.service';

@Module({
  imports: [DomainsModule, SurveysModule, MethodologyConfigModule],
  controllers: [AiDecisionsController, AiDecisionsReviewController, AiReviewController],
  providers: [AiDecisionsService],
  exports: [AiDecisionsService],
})
export class AiDecisionsModule {}
