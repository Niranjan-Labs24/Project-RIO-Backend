import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { SystemLogsController } from './system-logs.controller';
import { SystemLogsRetentionService } from './system-logs.retention';
import { SystemLogsService } from './system-logs.service';

/**
 * RIO-NFR-016 — operational logging.
 *
 * Global for the same reason AuditModule is: any service, filter, guard or
 * job may need to record an operational event, and threading a provider
 * import through every module that can fail would be noise.
 *
 * Relies on ScheduleModule.forRoot() being imported once in AppModule
 * (SchedulerRegistry is then injectable here without a local import) — the
 * same arrangement BackupModule uses.
 */
@Global()
@Module({
  imports: [ConfigModule],
  controllers: [SystemLogsController],
  providers: [SystemLogsService, SystemLogsRetentionService],
  exports: [SystemLogsService],
})
export class SystemLogsModule {}
