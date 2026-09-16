import { Module } from '@nestjs/common';
import { MailerModule } from '../../mailer/mailer.module';
import { SmsModule } from '../../sms/sms.module';
import { SurveyReminderService } from './survey-reminder.service';
import { SurveySessionsService } from './survey-sessions.service';

/**
 * Survey abandonment tracking + completion reminders (RPT10 Q-2, client
 * answer of 24 Aug). No controller of its own: the citizen-facing routes live
 * on CitizenController with the rest of the public survey flow, and RPT10
 * reads through SurveySessionsService.
 *
 * Relies on ScheduleModule.forRoot() being imported once, globally, in
 * AppModule — same as BackupModule and SystemLogsModule.
 */
@Module({
  imports: [MailerModule, SmsModule],
  providers: [SurveySessionsService, SurveyReminderService],
  exports: [SurveySessionsService],
})
export class SurveySessionsModule {}
