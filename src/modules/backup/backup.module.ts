import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';

// No controller — this is a background job, not an HTTP-facing module.
// Relies on ScheduleModule.forRoot() being imported once, globally, in
// AppModule (SchedulerRegistry is then injectable here without a local
// ScheduleModule import).
@Module({
  providers: [BackupService],
})
export class BackupModule {}
