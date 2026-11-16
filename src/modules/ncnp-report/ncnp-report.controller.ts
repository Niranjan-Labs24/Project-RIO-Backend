import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { RequirePermission } from '../../common/guards/permission.guard';
import { NcnpReportService } from './ncnp-report.service';
import { isDataQualityFilter, type NcnpReportFilters } from './ncnp-report-scope';
import type { NcnpReport } from './ncnp-report.types';

/**
 * The two filters, off the query string.
 *
 * An unknown dataQuality value is a 400 rather than a silent fall-through:
 * a filter that quietly does nothing is worse than one that refuses, since
 * the reader would take an unfiltered report for a filtered one. (The
 * locale param below keeps its fall-back contract — exporting in the wrong
 * language is a nuisance; reading the wrong population is a mistake.)
 */
function parseFilters(indicator?: string, dataQuality?: string): NcnpReportFilters {
  if (dataQuality != null && dataQuality !== '' && !isDataQualityFilter(dataQuality)) {
    throw new BadRequestException({
      error: {
        code: 'INVALID_DATA_QUALITY',
        message: 'dataQuality must be one of: excellent, low.',
      },
    });
  }
  return {
    indicator: indicator && indicator.trim() !== '' ? indicator.trim() : undefined,
    // Narrowed by the guard above; an empty string fell through it as "no
    // filter", so it cannot reach here.
    dataQuality: dataQuality ? dataQuality : undefined,
  };
}

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
    @Query('indicator') indicator?: string,
    @Query('dataQuality') dataQuality?: string,
  ): Promise<NcnpReport> {
    return this.ncnpReport.getReport(
      periodDays ? Number(periodDays) : undefined,
      dormantDays ? Number(dormantDays) : undefined,
      parseFilters(indicator, dataQuality),
    );
  }

  /**
   * The indicators the filter can offer. Static path, so it is declared
   * beside `export` and before any future `:param` route — same reason.
   */
  @Get('indicators')
  @RequirePermission('archiveSharingAudit', 'read')
  indicators(): Promise<string[]> {
    return this.ncnpReport.availableIndicators();
  }

  // Note the route order: this static path must be registered before any
  // future `:something` param route on this controller, or Nest would try
  // to match "export" as that param instead.
  @Get('export')
  @RateLimit(10, 60, { failOpenOnOutage: true })
  @RequirePermission('archiveSharingAudit', 'read')
  async export(
    @Query('format') format: string | undefined,
    @Query('periodDays') periodDays: string | undefined,
    @Query('dormantDays') dormantDays: string | undefined,
    @Query('locale') locale: string | undefined,
    @Query('indicator') indicator: string | undefined,
    @Query('dataQuality') dataQuality: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (format !== 'pdf' && format !== 'excel') {
      throw new BadRequestException({
        error: { code: 'EXPORT_FORMAT_NOT_SUPPORTED', message: 'format must be "pdf" or "excel".' },
      });
    }
    // Same "unexpected value falls back rather than errors" contract as the
    // enum label maps — an unsupported locale value exports in English
    // rather than 400ing a download over it.
    const file = await this.ncnpReport.exportReport(
      format,
      periodDays ? Number(periodDays) : undefined,
      dormantDays ? Number(dormantDays) : undefined,
      locale === 'ar' ? 'ar' : 'en',
      parseFilters(indicator, dataQuality),
    );
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': String(file.body.length),
    });
    res.end(file.body);
  }
}
