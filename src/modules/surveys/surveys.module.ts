import { Module } from '@nestjs/common';
import { MethodologyConfigModule } from '../methodology-config/methodology-config.module';
import { SurveysService } from './surveys.service';
import { SurveysController } from './surveys.controller';

@Module({
  imports: [MethodologyConfigModule],
  providers: [SurveysService],
  controllers: [SurveysController],
  exports: [SurveysService],
})
export class SurveysModule {}
