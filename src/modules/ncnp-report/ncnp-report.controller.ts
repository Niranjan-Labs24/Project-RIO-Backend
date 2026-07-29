import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../common/guards/permission.guard';
import { NcnpReportService } from './ncnp-report.service';
import type { NcnpReport } from './ncnp-report.types';

@Controller('ncnp-report')
export class NcnpReportController {
  constructor(private readonly ncnpReport: NcnpReportService) {}

  // Same permission SupervisorOverviewController already gates its
  // cross-org read on — see NcnpReportService.assertCrossEntity for the
  // additional crossEntity-role check underneath it.
  @Get()
  @RequirePermission('archiveSharingAudit', 'read')
  get(
    @Query('periodDays') periodDays?: string,
    @Query('dormantDays') dormantDays?: string,
  ): Promise<NcnpReport> {
    return this.ncnpReport.getReport(
      periodDays ? Number(periodDays) : undefined,
      dormantDays ? Number(dormantDays) : undefined,
    );
  }

  // Note the route order: this static path must be registered before any
  // future `:something` param route on this controller, or Nest would try
  // to match "export" as that param instead.
  @Get('export')
  @RequirePermission('archiveSharingAudit', 'read')
  async export(
    @Query('format') format: string | undefined,
    @Query('periodDays') periodDays: string | undefined,
    @Query('dormantDays') dormantDays: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (format !== 'pdf' && format !== 'excel') {
      throw new BadRequestException({
        error: { code: 'EXPORT_FORMAT_NOT_SUPPORTED', message: 'format must be "pdf" or "excel".' },
      });
    }
    const file = await this.ncnpReport.exportReport(
      format,
      periodDays ? Number(periodDays) : undefined,
      dormantDays ? Number(dormantDays) : undefined,
    );
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': String(file.body.length),
    });
    res.end(file.body);
  }
}
