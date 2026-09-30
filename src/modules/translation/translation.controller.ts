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

  // A whole screen's strings at once (see TranslateBatchBody). Each entry goes
  // through exactly the same translate() path — same cache, same quality
  // checks — just in parallel, a few at a time so a large uncached page
  // doesn't flood the AI provider. Results keep the input order.
  @Post('batch')
  @RateLimit(30, 60)
  async translateBatch(
    @Body(new TypeBoxValidationPipe(TranslateBatchBody)) body: TranslateBatchDto,
  ): Promise<TranslateContentResult[]> {
    const results: TranslateContentResult[] = new Array(body.texts.length);
    let next = 0;
    const worker = async () => {
      while (next < body.texts.length) {
        const i = next++;
        results[i] = await this.translation.translate(body.texts[i] as string, body.targetLocale);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, body.texts.length) }, worker));
    return results;
  }
}
