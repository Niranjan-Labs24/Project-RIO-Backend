import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  PublicTranslateBatchBody,
  PublicTranslateBody,
  type PublicTranslateBatchDto,
  type PublicTranslateDto,
} from './public-translation.contract';
import { PublicTranslationService } from './public-translation.service';

@Controller('public/translation')
@Public()
export class PublicTranslationController {
  constructor(private readonly translation: PublicTranslationService) {}

  @Post()
  @RateLimit(300, 60)
  translate(@Body(new TypeBoxValidationPipe(PublicTranslateBody)) body: PublicTranslateDto) {
    return this.translation.translate(body);
  }

  @Post('batch')
  @RateLimit(20, 60)
  translateBatch(
    @Body(new TypeBoxValidationPipe(PublicTranslateBatchBody)) body: PublicTranslateBatchDto,
  ) {
    return this.translation.translateBatch(body);
  }
}
