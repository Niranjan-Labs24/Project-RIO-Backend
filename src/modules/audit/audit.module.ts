import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

// Global so auth/organizations/users can inject AuditService to record events.
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
