import { Module } from '@nestjs/common';
import { MailerModule } from '../../mailer/mailer.module';
import { PublicSurveysController } from './public-surveys.controller';
import { PublicSurveysService } from './public-surveys.service';

@Module({
  imports: [MailerModule],
  controllers: [PublicSurveysController],
  providers: [PublicSurveysService],
})
export class PublicSurveysModule {}
