import { Module } from '@nestjs/common';
import { PublicSurveysController } from './public-surveys.controller';
import { PublicSurveysService } from './public-surveys.service';

@Module({
  controllers: [PublicSurveysController],
  providers: [PublicSurveysService],
})
export class PublicSurveysModule {}
