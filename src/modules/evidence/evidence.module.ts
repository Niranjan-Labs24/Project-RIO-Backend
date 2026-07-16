import { Module } from '@nestjs/common';
import { EvidenceController, EvidenceDeleteController } from './evidence.controller';
import { EvidenceService } from './evidence.service';
import { EvidenceStorageService } from './evidence.storage.service';

@Module({
  controllers: [EvidenceController, EvidenceDeleteController],
  providers: [EvidenceService, EvidenceStorageService],
})
export class EvidenceModule {}
