import { Module } from '@nestjs/common';
import { StudyConfigModule } from '../study-config/study-config.module';
import { NeedDecisionsController } from './need-decisions.controller';
import { NeedDecisionsService } from './need-decisions.service';

@Module({
  imports: [StudyConfigModule],
  controllers: [NeedDecisionsController],
  providers: [NeedDecisionsService],
  exports: [NeedDecisionsService],
})
export class NeedDecisionsModule {}
