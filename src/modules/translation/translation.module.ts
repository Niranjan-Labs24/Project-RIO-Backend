import { Module } from '@nestjs/common';
import { TranslationController } from './translation.controller';
import { TranslationService } from './translation.service';

// AiService (AiModule is @Global()) and PrismaService are both available
// app-wide without an explicit import here — see translation.service.ts.
@Module({
  controllers: [TranslationController],
  providers: [TranslationService],
  exports: [TranslationService],
})
export class TranslationModule {}
