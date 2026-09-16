import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreateNeedDecisionBody, UpdateNeedDecisionStatusBody } from './need-decisions.contract';
import type { CreateNeedDecisionDto, UpdateNeedDecisionStatusDto } from './need-decisions.contract';
import { NeedDecisionsService } from './need-decisions.service';
import type { NeedDecision } from './need-decisions.types';

// Gated on priorityScoring — the same module every other priority-related
// mutation (score, approve) already uses, since a decision only ever
// exists in relation to an approved priority score. Currently held with
// `create` by Data Analyst; NGO Admin (named in FR-005's own "User Role"
// field) holds priorityScoring read/export only today — widening that
// grant is an RBAC-matrix decision, not made here.
@Controller('needs/:needId/decisions')
export class NeedDecisionsController {
  constructor(private readonly decisions: NeedDecisionsService) {}

  @Get()
  @RequirePermission('priorityScoring', 'read')
  list(@Param('needId', new UuidParamPipe()) needId: string): Promise<NeedDecision[]> {
    return this.decisions.listForNeed(needId);
  }

  @Post()
  @RequirePermission('priorityScoring', 'create')
  create(
    @Param('needId', new UuidParamPipe()) needId: string,
    @Body(new TypeBoxValidationPipe(CreateNeedDecisionBody)) body: CreateNeedDecisionDto,
  ): Promise<NeedDecision> {
    return this.decisions.create(needId, body);
  }

  @Patch(':decisionId/status')
  @RequirePermission('priorityScoring', 'create')
  updateStatus(
    @Param('decisionId', new UuidParamPipe()) decisionId: string,
    @Body(new TypeBoxValidationPipe(UpdateNeedDecisionStatusBody)) body: UpdateNeedDecisionStatusDto,
  ): Promise<NeedDecision> {
    return this.decisions.updateStatus(decisionId, body);
  }
}
