import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

// ConsentService is exported so AuthModule can resolve the active policy of
// each kind during signup (RIO-DATA-001) rather than duplicating that lookup.
@Module({
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
