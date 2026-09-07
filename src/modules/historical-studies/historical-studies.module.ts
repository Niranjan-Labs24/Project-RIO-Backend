import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { StudyConfigModule } from '../study-config/study-config.module';
// RIO-DATA-002 — the prior-study import reuses NeedsImportService's parser,
// row validation and dedupe rather than duplicating them here.
import { NeedsModule } from '../needs/needs.module';
import { HistoricalStudiesController } from './historical-studies.controller';
import { HistoricalStudiesService } from './historical-studies.service';

@Module({
  imports: [EvidenceModule, StudyConfigModule, NeedsModule],
  controllers: [HistoricalStudiesController],
  providers: [HistoricalStudiesService],
})
export class HistoricalStudiesModule {}
