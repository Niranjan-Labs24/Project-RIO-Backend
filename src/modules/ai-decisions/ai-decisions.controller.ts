import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  AiReviewApproveBody,
  AiReviewOverrideDomainBody,
  AiReviewRejectBody,
  ReviewDecisionBody,
  type AiReviewApproveDto,
  type AiReviewOverrideDomainDto,
  type AiReviewRejectDto,
} from './ai-decisions.contract';
import { AiDecisionsService } from './ai-decisions.service';
import type { AiDecision, ReviewDecisionPayload, ScoringStubResponse } from './ai-decisions.types';

@Controller('needs/:needId/ai-decisions')
export class AiDecisionsController {
  constructor(private readonly aiDecisions: AiDecisionsService) {}

  // Classification itself now runs automatically right after Need creation
  // (see NeedsService.create) — this endpoint survives only as the Retry
  // action for a Need whose automatic classification failed.
  @Post('classify')
  @RequirePermission('aiReview', 'write')
  retryClassification(@Param('needId') needId: string): Promise<AiDecision> {
    return this.aiDecisions.retryClassification(needId);
  }

  @Get()
  @RequirePermission('aiReview', 'read')
  list(@Param('needId') needId: string): Promise<AiDecision[]> {
    return this.aiDecisions.listByNeedId(needId);
  }

  @Post('score')
  @RequirePermission('priorityScoring', 'create')
  score(): ScoringStubResponse {
    return this.aiDecisions.score();
  }
}

// The unified AI Review screen's own actions — Approve/Reject/Override are
// all Approver-only (`aiReview:approve`), same permission the old inline
// Approve/Override on the Need workspace page required.
@Controller('needs/:needId/ai-review')
export class AiReviewController {
  constructor(private readonly aiDecisions: AiDecisionsService) {}

  @Post('approve')
  @HttpCode(204)
  @RequirePermission('aiReview', 'approve')
  approve(
    @Param('needId') needId: string,
    @Body(new TypeBoxValidationPipe(AiReviewApproveBody)) body: AiReviewApproveDto,
  ): Promise<void> {
    return this.aiDecisions.approveAiReview(needId, body);
  }

  @Post('reject')
  @HttpCode(204)
  @RequirePermission('aiReview', 'approve')
  reject(
    @Param('needId') needId: string,
    @Body(new TypeBoxValidationPipe(AiReviewRejectBody)) body: AiReviewRejectDto,
  ): Promise<void> {
    return this.aiDecisions.rejectAiReview(needId, body.comments);
  }

  @Post('override-domain')
  @RequirePermission('aiReview', 'approve')
  overrideDomain(
    @Param('needId') needId: string,
    @Body(new TypeBoxValidationPipe(AiReviewOverrideDomainBody)) body: AiReviewOverrideDomainDto,
  ): Promise<unknown> {
    return this.aiDecisions.overrideDomainPreview(needId, body);
  }

  @Post('retry-classification')
  @RequirePermission('aiReview', 'write')
  retry(@Param('needId') needId: string): Promise<AiDecision> {
    return this.aiDecisions.retryClassification(needId);
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
