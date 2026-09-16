import { Body, Controller, Post } from '@nestjs/common';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { TranslateContentBody } from './translation.contract';
import { TranslationService } from './translation.service';
import type { TranslateContentDto } from './translation.contract';
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
  translate(
    @Body(new TypeBoxValidationPipe(TranslateContentBody)) body: TranslateContentDto,
  ): Promise<TranslateContentResult> {
    return this.translation.translate(body.text, body.targetLocale, body.sourceLocale);
  }
}
