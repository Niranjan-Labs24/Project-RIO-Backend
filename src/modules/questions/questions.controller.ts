import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { QuestionsService, type UpdateQuestionInput } from './questions.service';
import { RequirePermission } from '../../common/guards/permission.guard';
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
  // unlike GET /questions above). Gated on surveyBuilder:write since seeing
  // an inactive question is only useful to whoever can also reactivate it.
  @Get('questions/manage')
  @RequirePermission('surveyBuilder', 'write')
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

  // RIO-FR-012 — admin management. Gated on surveyBuilder:write, the same
  // action Research Officer and Human Reviewer already share for curating
  // survey questions — see role-matrix.ts. ⚠️ Which roles specifically
  // should manage the bank (vs. just curate a survey's own question list)
  // is still an open Sprint 2 clarification (Q3); narrow this once answered.
  @Patch('questions/:id')
  @RequirePermission('surveyBuilder', 'write')
  updateQuestion(
    @Param('id', new UuidParamPipe()) id: string,
    @Body() body: UpdateQuestionInput,
  ) {
    return this.service.update(id, body);
  }

  @Patch('questions/:id/deactivate')
  @RequirePermission('surveyBuilder', 'write')
  deactivateQuestion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.deactivate(id);
  }

  @Patch('questions/:id/reactivate')
  @RequirePermission('surveyBuilder', 'write')
  reactivateQuestion(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.reactivate(id);
  }
}
