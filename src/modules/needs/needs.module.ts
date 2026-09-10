import { Module } from '@nestjs/common';
import { GeographyModule } from '../geography/geography.module';
import { AiDecisionsModule } from '../ai-decisions/ai-decisions.module';
import { MethodologyConfigModule } from '../methodology-config/methodology-config.module';
import { AiModule } from '../ai/ai.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { DataCleaningModule } from '../data-cleaning/data-cleaning.module';
import { NeedsController } from './needs.controller';
import { NeedSummaryController } from './need-summary.controller';
import { NeedsImportService } from './needs-import.service';
import { NeedSummaryService } from './need-summary.service';
import { NeedsService } from './needs.service';
import { NeedThemesModule } from './need-themes.module';

@Module({
  imports: [GeographyModule, AiDecisionsModule, AiModule, StudyConfigModule, MethodologyConfigModule, NeedThemesModule, DataCleaningModule],
  controllers: [NeedsController, NeedSummaryController],
  providers: [NeedsService, NeedsImportService, NeedSummaryService],
  // NeedSummaryService is exported so the Reports module can resolve a Need's
  // confirmed summary when building RPT01/RPT15 — see
  // report-summary-data.provider.ts. NeedsImportService is exported so the
  // Historical Studies module can reuse the exact same parser, validation
  // and dedupe path for RIO-DATA-002 prior-study imports rather than growing
  // a second, drifting copy of it.
  exports: [NeedSummaryService, NeedsImportService],
})
export class NeedsModule {}
