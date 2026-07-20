import { Module } from '@nestjs/common';
import { DomainsModule } from '../domains/domains.module';
import { AiDecisionsController, AiDecisionsReviewController } from './ai-decisions.controller';
import { AiDecisionsService } from './ai-decisions.service';

@Module({
  imports: [DomainsModule],
  controllers: [AiDecisionsController, AiDecisionsReviewController],
  providers: [AiDecisionsService],
})
export class AiDecisionsModule {}
