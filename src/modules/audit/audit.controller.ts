import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
import { AuditService } from './audit.service';
import { AuditCheckpointService, type VerifyResult } from './audit-checkpoint.service';
import type { AuditListResult } from './audit.types';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly checkpoints: AuditCheckpointService,
  ) {}

  @Get()
  @RequirePermission('auditLog', 'read')
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
    @Query('search') search?: string,
    @Query('sourceRef') sourceRef?: string,
  ): Promise<AuditListResult> {
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
      search: search || undefined,
      sourceRef: sourceRef || undefined,
    });
  }

  // export param is currently only used for the required `?format=csv`
  // query string; kept in the signature for the CSV/PDF/Excel contract
  // parity note above exportCsv().
  @Get('export')
  @RequirePermission('auditLog', 'export')
  async export(
    @Res({ passthrough: true }) res: Response,
    @Query('organizationId') organizationId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
    @Query('sourceRef') sourceRef?: string,
  ): Promise<string> {
    const csv = await this.audit.exportCsv({
      organizationId: organizationId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      actorId: actorId || undefined,
      action: action || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      search: search || undefined,
      sourceRef: sourceRef || undefined,
    });
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return csv;
  }

  @Get('summary')
  @RequirePermission('auditLog', 'read')
  getSummary() {
    return this.audit.getSummary();
  }

  // GAP-02 — checkpoint-chain integrity check. Gated on systemLogs (held by
  // system_admin alone — see role-matrix.ts), deliberately NOT auditLog:
  // auditLog is also granted to center_supervisor, but whether the
  // tamper-evidence chain itself is intact is platform-operations
  // territory, same posture as system_logs. Declared before the ':id' route
  // below so the literal "integrity" segment is never swallowed as an id
  // (same ordering note as system-logs.controller.ts's request/:requestId).
  @Get('integrity')
  @RequirePermission('systemLogs', 'read')
  getIntegrity(): Promise<VerifyResult> {
    return this.checkpoints.verify();
  }

  @Get(':id')
  @RequirePermission('auditLog', 'read')
  getById(@Param('id') id: string) {
    return this.audit.getById(id);
  }
}
