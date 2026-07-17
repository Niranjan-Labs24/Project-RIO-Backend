import { Module } from '@nestjs/common';
import { NeedsController } from './needs.controller';
import { NeedsService } from './needs.service';

@Module({
  controllers: [NeedsController],
  providers: [NeedsService],
})
export class NeedsModule {}
