import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  ApproveNcnpReportBody,
  ApproveNcnpReportDto,
  GenerateNcnpReportBody,
  GenerateNcnpReportDto,
  RejectNcnpReportBody,
  RejectNcnpReportDto,
} from './ncnp-report-review.contract';
import { NcnpReportReviewService } from './ncnp-report-review.service';

@Controller('ncnp-report-reviews')
export class NcnpReportReviewController {
  constructor(private readonly service: NcnpReportReviewService) {}

  // System Admin only — generates a new frozen snapshot for review.
  @Post()
  @RequirePermission('ncnpReport', 'write')
  generate(@Body(new TypeBoxValidationPipe(GenerateNcnpReportBody)) body: GenerateNcnpReportDto) {
    return this.service.generate(body.periodDays, body.dormantDays);
  }

  @Get()
  @RequirePermission('ncnpReport', 'read')
  list(@Query('status') status?: string) {
    return this.service.list(status);
  }

  // Derived/computed alerts for the notifications bell — same pattern as
  // ReviewerSlaService, correctly scoped to this module's own permission
  // rather than extending reviewer-sla (which is deliberately gated on
  // surveyBuilder:read, a permission System Reviewer never holds). Declared
  // before the `:id` route below so "alerts" isn't captured as an id.
  @Get('alerts')
  @RequirePermission('ncnpReport', 'read')
  listAlerts() {
    return this.service.listAlerts();
  }

  @Get(':id')
  @RequirePermission('ncnpReport', 'read')
  getById(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.getById(id);
  }

  // Exports this specific review's frozen snapshot (not always-live current
  // data) with a full Audit Trail — only reachable once Released, same rule
  // the UI enforces. Gated on `ncnpReport:read` (not `archiveSharingAudit`,
  // which System Reviewer never holds) so both roles that can view a
  // released report can also export it.
  @Get(':id/export')
  @RequirePermission('ncnpReport', 'read')
  async export(
    @Param('id', new UuidParamPipe()) id: string,
    @Query('format') format: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (format !== 'pdf' && format !== 'excel') {
      throw new BadRequestException({
        error: { code: 'EXPORT_FORMAT_NOT_SUPPORTED', message: 'format must be "pdf" or "excel".' },
      });
    }
    const file = await this.service.exportReport(id, format);
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Content-Length': String(file.body.length),
    });
    res.end(file.body);
  }

  // System Reviewer only — approve/reject both require mandatory notes.
  @Patch(':id/approve')
  @RequirePermission('ncnpReport', 'approve')
  approve(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(ApproveNcnpReportBody)) body: ApproveNcnpReportDto,
  ) {
    return this.service.approve(id, body.notes);
  }

  @Patch(':id/reject')
  @RequirePermission('ncnpReport', 'approve')
  reject(
    @Param('id', new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(RejectNcnpReportBody)) body: RejectNcnpReportDto,
  ) {
    return this.service.reject(id, body.notes);
  }

  // System Admin only — final publish, no notes required.
  @Patch(':id/publish')
  @RequirePermission('ncnpReport', 'write')
  publish(@Param('id', new UuidParamPipe()) id: string) {
    return this.service.publish(id);
  }
}
