import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { parseIntParam } from '../../common/http/query.util';
import { SystemLogsService } from './system-logs.service';
import {
  isSystemLogCategory,
  isSystemLogLevel,
  type SystemLogListResult,
  type SystemLogEntry,
  type SystemLogQuery,
  type SystemLogSummary,
  type SystemLogSummaryWindow,
} from './system-logs.types';

const WINDOWS: readonly SystemLogSummaryWindow[] = ['1h', '24h', '7d', '30d'];

/**
 * RIO-NFR-016 — read-only operational log API.
 *
 * Every route is gated on `systemLogs`, a module only System Admin holds
 * (see rbac/role-matrix.ts). There is deliberately no write, update, or
 * delete route: rows arrive only from inside the process, and the sole
 * deletion path is the retention job, which is not reachable over HTTP.
 */
@Controller('system-logs')
export class SystemLogsController {
  constructor(private readonly logs: SystemLogsService) {}

  @Get()
  @RequirePermission('systemLogs', 'read')
  list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('level') level?: string,
    @Query('minLevel') minLevel?: string,
    @Query('category') category?: string,
    @Query('source') source?: string,
    @Query('eventCode') eventCode?: string,
    @Query('requestId') requestId?: string,
    @Query('organizationId') organizationId?: string,
    @Query('actorId') actorId?: string,
    @Query('statusCode') statusCode?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
  ): Promise<SystemLogListResult> {
    return this.logs.list({
      ...parseFilters({
        level,
        minLevel,
        category,
        source,
        eventCode,
        requestId,
        organizationId,
        actorId,
        statusCode,
        dateFrom,
        dateTo,
        search,
      }),
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
    });
  }

  @Get('summary')
  @RequirePermission('systemLogs', 'read')
  getSummary(@Query('window') window?: string): Promise<SystemLogSummary> {
    const w = WINDOWS.includes(window as SystemLogSummaryWindow)
      ? (window as SystemLogSummaryWindow)
      : '24h';
    return this.logs.getSummary(w);
  }

  @Get('export')
  @RequirePermission('systemLogs', 'export')
  async export(
    @Res({ passthrough: true }) res: Response,
    @Query('level') level?: string,
    @Query('minLevel') minLevel?: string,
    @Query('category') category?: string,
    @Query('source') source?: string,
    @Query('eventCode') eventCode?: string,
    @Query('requestId') requestId?: string,
    @Query('organizationId') organizationId?: string,
    @Query('actorId') actorId?: string,
    @Query('statusCode') statusCode?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
  ): Promise<string> {
    const csv = await this.logs.exportCsv(
      parseFilters({
        level,
        minLevel,
        category,
        source,
        eventCode,
        requestId,
        organizationId,
        actorId,
        statusCode,
        dateFrom,
        dateTo,
        search,
      }),
    );
    res.set({
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="system-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return csv;
  }

  // Declared before ':id' so a literal path segment can never be swallowed
  // by the parameterised route.
  @Get('request/:requestId')
  @RequirePermission('systemLogs', 'read')
  getByRequest(@Param('requestId') requestId: string): Promise<{ items: SystemLogEntry[] }> {
    return this.logs.getByRequestId(requestId);
  }

  @Get(':id')
  @RequirePermission('systemLogs', 'read')
  getById(@Param('id') id: string): Promise<SystemLogEntry> {
    return this.logs.getById(id);
  }
}

/**
 * Query strings are strings; `level`/`category` are enums and `statusCode`
 * is numeric. Anything that isn't a valid member is dropped rather than
 * passed through — an unknown filter value must widen the result set back to
 * "unfiltered", never reach Prisma as an invalid enum and 500.
 */
function parseFilters(raw: Record<string, string | undefined>): SystemLogQuery {
  const statusCode = parseIntParam(raw.statusCode);
  return {
    level: isSystemLogLevel(raw.level) ? raw.level : undefined,
    minLevel: isSystemLogLevel(raw.minLevel) ? raw.minLevel : undefined,
    category: isSystemLogCategory(raw.category) ? raw.category : undefined,
    source: raw.source || undefined,
    eventCode: raw.eventCode || undefined,
    requestId: raw.requestId || undefined,
    organizationId: raw.organizationId || undefined,
    actorId: raw.actorId || undefined,
    statusCode,
    dateFrom: raw.dateFrom || undefined,
    dateTo: raw.dateTo || undefined,
    search: raw.search || undefined,
  };
}
