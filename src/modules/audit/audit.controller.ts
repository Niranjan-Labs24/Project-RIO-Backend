import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
import { AuditService } from './audit.service';
import {
  EXPORT_CONTENT_TYPE, exportFilename, parseExportFormat, toCsv, toXlsx,
} from '../../common/export/tabular-export';
import { parseLocale, requestLocale } from '../../common/locale/request-locale';
import type { AuditListResult } from './audit.types';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';

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
  @RateLimit(10, 60, { failOpenOnOutage: true })
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
    @Query('search') search?: string,
    @Query('sourceRef') sourceRef?: string,
    // UAT AUD-03 — csv (UTF-8 with BOM) or xlsx; headers in ?locale= or the
    // caller's own language.
    @Query('format') formatParam?: string,
    @Query('locale') localeParam?: string,
  ): Promise<string | StreamableFile> {
    const format = parseExportFormat(formatParam);
    const locale = parseLocale(localeParam) ?? requestLocale();
    const table = await this.audit.exportTable({
      organizationId: organizationId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      actorId: actorId || undefined,
      action: action || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      search: search || undefined,
      sourceRef: sourceRef || undefined,
    }, locale);
    res.set({
      'Content-Type': EXPORT_CONTENT_TYPE[format],
      'Content-Disposition': `attachment; filename="${exportFilename('audit-log', format)}"`,
    });
    return format === 'xlsx'
      // A Buffer returned as-is would be JSON-serialised by Nest ({"type":"Buffer",...}).
      ? new StreamableFile(await toXlsx(table, { sheetName: locale === 'ar' ? 'سجل التدقيق' : 'Audit log', rightToLeft: locale === 'ar' }))
      : toCsv(table);
  }

  @Get('summary')
  @RequirePermission('archiveSharingAudit', 'read')
  getSummary() {
    return this.audit.getSummary();
  }

  @Get(':id')
  @RequirePermission('archiveSharingAudit', 'read')
  getById(@Param('id', new UuidParamPipe()) id: string) {
    return this.audit.getById(id);
  }
}
