import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { HistoricalStudiesController } from './historical-studies.controller';
import { HistoricalStudiesService } from './historical-studies.service';

@Module({
  imports: [EvidenceModule, StudyConfigModule],
  controllers: [HistoricalStudiesController],
  providers: [HistoricalStudiesService],
  // ArchiveModule reuses list()'s cross-entity-aware Governorate/Center/
  // uploader-name enrichment rather than re-implementing it — see
  // ArchiveService's historical-entry branch.
  exports: [HistoricalStudiesService],
})
export class HistoricalStudiesModule {}
