import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { AuditService } from './audit.service';
import type { AuditEvent } from './audit.types';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('archiveSharingAudit', 'read')
  list(
    @Query('limit') limit?: string,
    @Query('organizationId') organizationId?: string,
  ): Promise<AuditEvent[]> {
    return this.audit.list({
      limit: limit ? Number(limit) : undefined,
      organizationId: organizationId || undefined,
    });
  }
}
