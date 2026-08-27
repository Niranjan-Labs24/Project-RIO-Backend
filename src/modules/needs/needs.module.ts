import { Module } from '@nestjs/common';
import { GeographyModule } from '../geography/geography.module';
import { AiDecisionsModule } from '../ai-decisions/ai-decisions.module';
import { AiModule } from '../ai/ai.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { NeedsController } from './needs.controller';
import { NeedsImportService } from './needs-import.service';
import { NeedsService } from './needs.service';

@Module({
  imports: [GeographyModule, AiDecisionsModule, AiModule, StudyConfigModule],
  controllers: [NeedsController],
  providers: [NeedsService, NeedsImportService],
})
export class NeedsModule {}
