import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { parseIntParam } from "../../common/http/query.util";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { ApproveReportBody, CreateReportBody, RejectReportBody, type ApproveReportDto, type RejectReportDto } from "./reports.contract";
import { ReportsService } from "./reports.service";
import type {
  CreateReportPayload, ExportFormat, ListReportsParams, Report, ReportStatus, ReportTypeCode,
} from "./reports.types";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @RequirePermission("reportsDashboards", "create")
  create(@Body(new TypeBoxValidationPipe(CreateReportBody)) body: CreateReportPayload): Promise<Report> {
    return this.reports.create(body);
  }

  @Get()
  @RequirePermission("reportsDashboards", "read")
  list(
    @Query("organizationId") organizationId?: string,
    @Query("reportType") reportType?: ReportTypeCode,
    @Query("status") status?: ReportStatus,
    @Query("studyId") studyId?: string,
    @Query("surveyId") surveyId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ): Promise<Report[]> {
    const params: ListReportsParams = {
      organizationId: organizationId || undefined,
      reportType,
      status,
      studyId,
      surveyId: surveyId || undefined,
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
    };
    return this.reports.list(params);
  }

  @Get(":id")
  @RequirePermission("reportsDashboards", "read")
  getById(@Param("id", new UuidParamPipe()) id: string): Promise<Report> {
    return this.reports.getById(id);
  }

  // Officer confirms (step 1 of two-step approval) — a `write`-level action,
  // distinct from the Reviewer's `approve` that follows.
  @Patch(":id/confirm")
  @RequirePermission("reportsDashboards", "write")
  confirm(@Param("id", new UuidParamPipe()) id: string): Promise<Report> {
    return this.reports.confirm(id);
  }

  @Patch(":id/approve")
  @RequirePermission("reportsDashboards", "approve")
  approve(
    @Param("id", new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(ApproveReportBody)) body: ApproveReportDto,
  ): Promise<Report> {
    return this.reports.approve(id, body.notes);
  }

  @Patch(":id/reject")
  @RequirePermission("reportsDashboards", "approve")
  reject(
    @Param("id", new UuidParamPipe()) id: string,
    @Body(new TypeBoxValidationPipe(RejectReportBody)) body: RejectReportDto,
  ): Promise<Report> {
    return this.reports.reject(id, body.notes);
  }

  @Patch(":id/archive")
  @RequirePermission("reportsDashboards", "approve")
  archive(@Param("id", new UuidParamPipe()) id: string): Promise<Report> {
    return this.reports.archive(id);
  }

  @Get(":id/export")
  @RequirePermission("reportsDashboards", "export")
  async export(@Param("id", new UuidParamPipe()) id: string, @Query("format") format: ExportFormat, @Res() res: Response): Promise<void> {
    const file = await this.reports.export(id, format);
    res.set({
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.body.length),
    });
    res.end(file.body);
  }
}
