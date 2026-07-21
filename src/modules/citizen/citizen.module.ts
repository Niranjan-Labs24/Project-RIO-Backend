import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { MailerModule } from '../../mailer/mailer.module';
import { SurveysModule } from '../surveys/surveys.module';
import { PriorityModule } from '../priority/priority.module';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';

@Module({
  imports: [MailerModule, SurveysModule, PriorityModule],
  controllers: [CitizenController],
  providers: [CitizenService, PasswordService],
})
export class CitizenModule {}
