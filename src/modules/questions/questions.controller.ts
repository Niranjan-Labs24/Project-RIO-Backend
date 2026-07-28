import { Controller, Get, Query } from '@nestjs/common';
import { QuestionsService } from './questions.service';
import { RequirePermission } from '../../common/guards/permission.guard';

@Controller('question-bank')
export class QuestionsController {
  constructor(private readonly service: QuestionsService) {}

  @Get('domain-options')
  @RequirePermission('surveyBuilder', 'read')
  getDomainOptions() {
    return this.service.getDomainOptions();
  }

  @Get('kpi-options')
  @RequirePermission('surveyBuilder', 'read')
  getKpiOptions() {
    return this.service.getKpiOptions();
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
    return this.service.getQuestions(pairs);
  }
}
