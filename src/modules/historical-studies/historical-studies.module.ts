import { Module } from '@nestjs/common';
import { EvidenceModule } from '../evidence/evidence.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { HistoricalStudiesController } from './historical-studies.controller';
import { HistoricalStudiesService } from './historical-studies.service';

@Module({
  imports: [EvidenceModule, StudyConfigModule],
  controllers: [HistoricalStudiesController],
  providers: [HistoricalStudiesService],
})
export class HistoricalStudiesModule {}
