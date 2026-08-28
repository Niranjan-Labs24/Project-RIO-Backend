import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { SmsModule } from '../../sms/sms.module';
import { SurveysModule } from '../surveys/surveys.module';
import { PriorityModule } from '../priority/priority.module';
import { SurveySessionsModule } from '../survey-sessions/survey-sessions.module';
import { ConsentModule } from '../consent/consent.module';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';

@Module({
  imports: [SmsModule, SurveysModule, PriorityModule, SurveySessionsModule, ConsentModule],
  controllers: [CitizenController],
  providers: [CitizenService, PasswordService],
})
export class CitizenModule {}
