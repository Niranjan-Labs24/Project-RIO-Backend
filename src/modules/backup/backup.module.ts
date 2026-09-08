import { Module } from '@nestjs/common';
import { MailerModule } from '../../mailer/mailer.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { BackupController } from './backup.controller';
import { LocalFilesystemDestination } from './backup-destination';
import { BACKUP_DESTINATION } from './backup-destination.token';
import { BackupService } from './backup.service';

// RIO-NFR-010 gave this module a controller: AC 2 ("backup logs auditable")
// needs a surface an administrator can actually read them on, and AC 1
// ("recoverable") needs somewhere to trigger and verify a run.
//
// Relies on ScheduleModule.forRoot() being imported once, globally, in
// AppModule (SchedulerRegistry is then injectable here without a local
// ScheduleModule import).
@Module({
  imports: [PrismaModule, AuditModule, MailerModule, ConfigModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    // Q34's swap point. When the client names a destination, this factory
    // returns that adapter and nothing else in the module changes.
    {
      provide: BACKUP_DESTINATION,
      useFactory: (config: ConfigService) =>
        new LocalFilesystemDestination(config.backupEncryptionKey),
      inject: [ConfigService],
    },
  ],
  exports: [BackupService],
})
export class BackupModule {}
