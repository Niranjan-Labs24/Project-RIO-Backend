import { Module } from '@nestjs/common';
import { NeedsController } from './needs.controller';
import { NeedsImportService } from './needs-import.service';
import { NeedsService } from './needs.service';

@Module({
  controllers: [NeedsController],
  providers: [NeedsService, NeedsImportService],
})
export class NeedsModule {}
