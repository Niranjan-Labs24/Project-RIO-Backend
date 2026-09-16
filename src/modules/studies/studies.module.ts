import { Module } from '@nestjs/common';
import { GeographyModule } from '../geography/geography.module';
import { StudyConfigModule } from '../study-config/study-config.module';
import { StudiesController } from './studies.controller';
import { StudiesService } from './studies.service';

@Module({
  imports: [GeographyModule, StudyConfigModule],
  controllers: [StudiesController],
  providers: [StudiesService],
  exports: [StudiesService],
})
export class StudiesModule {}
