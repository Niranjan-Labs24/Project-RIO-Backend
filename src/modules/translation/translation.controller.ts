import { Body, Controller, Post } from '@nestjs/common';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { TranslateBatchBody, TranslateContentBody } from './translation.contract';
import { TranslationService } from './translation.service';
import type { TranslateBatchDto, TranslateContentDto } from './translation.contract';
import type { TranslateContentResult } from './translation.types';

// No @RequirePermission — this is a read-mostly utility (translate this
// string, or fetch it from cache) with no tenant-sensitive data of its own;
// it only ever sees text the calling user's own screen already showed them.
// Still behind the global JwtAuthGuard (no @Public()), so it's
// authenticated-user-only, matching how every other locale-driven UI
// concern (e.g. master-data nameAr lookups) is already exposed.
@Controller('translation')
export class TranslationController {
  constructor(private readonly translation: TranslationService) {}

  @Post()
  // Fires passively via AutoTranslate on nearly every screen render, not a
  // deliberate AI-generation click — tiered with screen loads/lookups
  // (300/min), not the 30/min AI-generation tier.
  @RateLimit(300, 60)
  translate(
    @Body(new TypeBoxValidationPipe(TranslateContentBody)) body: TranslateContentDto,
  ): Promise<TranslateContentResult> {
    return this.translation.translate(body.text, body.targetLocale, body.sourceLocale);
  }

  // A whole screen's strings at once (see TranslateBatchBody), through
  // translateMany: every cached answer in one query and the misses in a few
  // batched provider calls, instead of one provider call per string — the
  // per-string fan-out was the main cost behind UAT GEN-09 ("slow"). Same
  // cache and quality rules; results keep the input order. AutoTranslate now
  // sends a screen's strings here passively, so it sits in the same
  // screen-load tier as the single-string endpoint above.
  @Post('batch')
  @RateLimit(300, 60)
  async translateBatch(
    @Body(new TypeBoxValidationPipe(TranslateBatchBody)) body: TranslateBatchDto,
  ): Promise<TranslateContentResult[]> {
    return this.translation.translateMany(body.texts, body.targetLocale);
  }
}
