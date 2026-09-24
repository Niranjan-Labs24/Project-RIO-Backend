import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { PublicTranslateBody, type PublicTranslateDto } from './public-translation.contract';
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
}
