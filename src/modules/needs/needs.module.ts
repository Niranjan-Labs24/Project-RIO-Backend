import { Module } from '@nestjs/common';
import { GeographyModule } from '../geography/geography.module';
import { AiDecisionsModule } from '../ai-decisions/ai-decisions.module';
import { MethodologyConfigModule } from '../methodology-config/methodology-config.module';
import { AiModule } from '../ai/ai.module';
import { NeedsController } from './needs.controller';
import { NeedSummaryController } from './need-summary.controller';
import { NeedsImportService } from './needs-import.service';
import { NeedSummaryService } from './need-summary.service';
import { NeedsService } from './needs.service';
import { NeedThemesModule } from './need-themes.module';

@Module({
  imports: [GeographyModule, AiDecisionsModule, AiModule, MethodologyConfigModule, NeedThemesModule],
  controllers: [NeedsController, NeedSummaryController],
  providers: [NeedsService, NeedsImportService, NeedSummaryService],
  // Exported so the Reports module can resolve a Need's confirmed summary when
  // building RPT01/RPT15 — see report-summary-data.provider.ts.
  exports: [NeedSummaryService],
})
export class NeedsModule {}
