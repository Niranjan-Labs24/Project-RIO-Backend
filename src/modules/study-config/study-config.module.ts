import { Module } from '@nestjs/common';
import { StudyConfigController } from './study-config.controller';
import { StudyConfigService } from './study-config.service';

@Module({
  controllers: [StudyConfigController],
  providers: [StudyConfigService],
  exports: [StudyConfigService],
})
export class StudyConfigModule {}
