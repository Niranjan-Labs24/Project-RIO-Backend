import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
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
    @Query('action') action?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<AuditEvent[]> {
    return this.audit.list({
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
      organizationId: organizationId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      actorId: actorId || undefined,
      action: action || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    });
  }

  // export param is currently only used for the required `?format=csv`
  // query string; kept in the signature for the CSV/PDF/Excel contract
  // parity note above exportCsv().
  @Get('export')
  @RequirePermission('archiveSharingAudit', 'export')
  async export(
    @Res({ passthrough: true }) res: Response,
    @Query('organizationId') organizationId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ): Promise<string> {
    const csv = await this.audit.exportCsv({
      organizationId: organizationId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      actorId: actorId || undefined,
      action: action || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    });
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return csv;
  }
}
