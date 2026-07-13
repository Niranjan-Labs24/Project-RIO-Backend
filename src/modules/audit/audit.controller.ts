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
    @Query('offset') offset?: string,
    @Query('organizationId') organizationId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorId') actorId?: string,
  ): Promise<AuditEvent[]> {
    return this.audit.list({
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
      organizationId: organizationId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      actorId: actorId || undefined,
    });
  }
}
