import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { QuestionsService, type CreateQuestionInput, type UpdateQuestionInput } from './questions.service';
import { CreateQuestionBody, type CreateQuestionDto } from './questions.contract';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';

@Controller('question-bank')
export class QuestionsController {
  constructor(private readonly service: QuestionsService) {}

  // `methodologyVersion` is the caller's own snapshot label (a Survey stores one
  // in Survey.methodologyVersion). Omitted means "the latest PUBLISHED version" —
  // see QuestionsService.resolveVersionId. It is never "all versions": a
  // question's identity is (methodologyVersionId, questionId), and mixing banks
  // is what made surveys pick unscoreable legacy twins of real questions.
  @Get('domain-options')
  @RequirePermission('surveyBuilder', 'read')
  getDomainOptions(@Query('methodologyVersion') methodologyVersion?: string) {
    return this.service.getDomainOptions(methodologyVersion);
  }

  @Get('kpi-options')
  @RequirePermission('surveyBuilder', 'read')
  getKpiOptions(@Query('methodologyVersion') methodologyVersion?: string) {
    return this.service.getKpiOptions(methodologyVersion);
  }

  // Same gate/shape as domain-options/kpi-options — Survey Builder's Sample
  // Description "Target Group" combobox reads this.
  @Get('target-respondent-options')
  @RequirePermission('surveyBuilder', 'read')
  getTargetRespondentOptions(@Query('methodologyVersion') methodologyVersion?: string) {
    return this.service.getTargetRespondentOptions(methodologyVersion);
  }

  // `pairs` (JSON-encoded array of {domain, subDomain}) is the multi-domain-
  // aware shape — takes priority when present. `domain`/`subDomain` stay as
  // a single-pair fallback for backward compatibility. Neither given means
  // "every active Question Bank entry" (see QuestionsService.getQuestions).
  @Get('questions')
  @RequirePermission('surveyBuilder', 'read')
  getQuestions(
    @Query('domain') domain?: string,
    @Query('subDomain') subDomain?: string,
    @Query('pairs') pairsParam?: string,
    @Query('methodologyVersion') methodologyVersion?: string,
  ) {
    let pairs: Array<{ domain: string; subDomain: string }> = [];
    if (pairsParam) {
      try {
        const parsed: unknown = JSON.parse(pairsParam);
        if (Array.isArray(parsed)) {
          pairs = parsed.filter(
            (p): p is { domain: string; subDomain: string } =>
              Boolean(p) && typeof p.domain === 'string' && typeof p.subDomain === 'string',
          );
        }
      } catch {
        // Malformed pairs param — fall through to the domain/subDomain
        // fallback below rather than erroring the whole request.
      }
    }
    if (pairs.length === 0 && domain && subDomain) {
      pairs = [{ domain, subDomain }];
    }
    return this.service.getQuestions(pairs, methodologyVersion);
  }

  // RIO-FR-012 — admin management listing (includes deactivated questions,
  // unlike GET /questions above). Gated on methodologyQuestionBank:read —
  // this is a VIEW, not a change: every role that can see the Question
  // Bank tab at all (Research Officer, Field Researcher, Human Reviewer,
  // Data Analyst, System Admin, etc. — all hold at least `read`) needs this
  // to actually load. Only the write actions below (edit/deactivate/create)
  // are restricted to NCNP Admin (System Admin), per Q31. This endpoint was
  // previously gated on `write`, which 403'd every non-System-Admin role
  // out of the whole tab — a real bug, not the intended scope.
  @Get('questions/manage')
  @RequirePermission('methodologyQuestionBank', 'read')
  getQuestionsForManagement(
    @Query('domain') domain?: string,
    @Query('subDomain') subDomain?: string,
    @Query('pairs') pairsParam?: string,
    @Query('methodologyVersion') methodologyVersion?: string,
  ) {
    let pairs: Array<{ domain: string; subDomain: string }> = [];
    if (pairsParam) {
      try {
        const parsed: unknown = JSON.parse(pairsParam);
        if (Array.isArray(parsed)) {
          pairs = parsed.filter(
            (p): p is { domain: string; subDomain: string } =>
              Boolean(p) && typeof p.domain === 'string' && typeof p.subDomain === 'string',
          );
        }
      } catch {
        // Malformed pairs param — fall through to the domain/subDomain
        // fallback below rather than erroring the whole request.
      }
    }
    if (pairs.length === 0 && domain && subDomain) {
      pairs = [{ domain, subDomain }];
    }
    return this.service.getQuestionsForManagement(pairs, methodologyVersion);
  }

  // RIO-FR-012 (AC3, Q31 client-confirmed) — a genuinely new question.
  // "Creating a new question" is explicitly one of the change types
  // requiring Human Reviewer approval before it's active for new surveys —
  // same gate and same pending-approval mechanism as the edit actions below.
  @Post('questions')
  @RequirePermission('methodologyQuestionBank', 'write')
  createQuestion(
    @Body(new TypeBoxValidationPipe(CreateQuestionBody)) body: CreateQuestionDto,
  ) {
    return this.service.create(body as CreateQuestionInput);
  }

  // RIO-FR-012 (Q31, client-confirmed 2026-08-20) — only NCNP Admin (System
  // Admin) may initiate a Question Bank change. Every one of these three
  // actions now creates a pending, non-current version awaiting Human
  // Reviewer approval (see QuestionsService.createPendingVersion) rather
  // than taking effect immediately.
  @Patch('questions/:id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateQuestion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body() body: UpdateQuestionInput,
  ) {
    return this.service.update(id, body);
  }

  @Patch('questions/:id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateQuestion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.deactivate(id);
  }

  @Patch('questions/:id/reactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  reactivateQuestion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.reactivate(id);
  }

  // RIO-FR-012 (Q31) — Human Reviewer's approval queue and decision actions.
  // Gated on the `approve` action specifically, not `write` — a Reviewer
  // approves/rejects changes NCNP Admin submitted, they don't submit their
  // own (see role-matrix.ts: human_reviewer holds approve, not write, on
  // methodologyQuestionBank).
  @Get('questions/pending-approvals')
  @RequirePermission('methodologyQuestionBank', 'approve')
  listPendingApprovals() {
    return this.service.listPendingApprovals();
  }

  @Patch('questions/:id/approve')
  @RequirePermission('methodologyQuestionBank', 'approve')
  approveQuestion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.approve(id);
  }

  @Patch('questions/:id/reject')
  @RequirePermission('methodologyQuestionBank', 'approve')
  rejectQuestion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body('reason') reason: string,
  ) {
    return this.service.reject(id, reason);
  }
}
