import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { ReviewDecisionBody } from './ai-decisions.contract';
import { AiDecisionsService } from './ai-decisions.service';
import type { AiDecision, ReviewDecisionPayload, ScoringStubResponse } from './ai-decisions.types';

@Controller('studies/:studyId/ai-decisions')
export class AiDecisionsController {
  constructor(private readonly aiDecisions: AiDecisionsService) {}

  @Post('classify')
  @RequirePermission('aiReview', 'write')
  classify(@Param('studyId') studyId: string): Promise<AiDecision> {
    return this.aiDecisions.classify(studyId);
  }

  @Get()
  @RequirePermission('aiReview', 'read')
  list(@Param('studyId') studyId: string): Promise<AiDecision[]> {
    return this.aiDecisions.listByStudyId(studyId);
  }

  @Post('score')
  @RequirePermission('priorityScoring', 'create')
  score(): ScoringStubResponse {
    return this.aiDecisions.score();
  }
}

@Controller('ai-decisions')
export class AiDecisionsReviewController {
  constructor(private readonly aiDecisions: AiDecisionsService) {}

  @Patch(':id/review')
  @RequirePermission('aiReview', 'approve')
  review(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(ReviewDecisionBody)) body: ReviewDecisionPayload,
  ): Promise<AiDecision> {
    return this.aiDecisions.review(id, body);
  }
}
