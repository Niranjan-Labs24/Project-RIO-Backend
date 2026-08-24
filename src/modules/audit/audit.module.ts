import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditCheckpointService } from './audit-checkpoint.service';

// Global so auth/organizations/users can inject AuditService to record events.
//
// AuditCheckpointService (GAP-02) relies on ScheduleModule.forRoot() being
// imported once in AppModule (SchedulerRegistry is then injectable here
// without a local import) — the same arrangement CitizenPiiRetentionService/
// BackupService use.
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditCheckpointService],
  exports: [AuditService, AuditCheckpointService],
})
export class AuditModule {}
