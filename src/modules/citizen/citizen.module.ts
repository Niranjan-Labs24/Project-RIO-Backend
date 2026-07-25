import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { SmsModule } from '../../sms/sms.module';
import { SurveysModule } from '../surveys/surveys.module';
import { PriorityModule } from '../priority/priority.module';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';

@Module({
  imports: [SmsModule, SurveysModule, PriorityModule],
  controllers: [CitizenController],
  providers: [CitizenService, PasswordService],
})
export class CitizenModule {}
