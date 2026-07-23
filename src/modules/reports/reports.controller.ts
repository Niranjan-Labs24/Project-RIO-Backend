import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { CreateReportBody } from "./reports.contract";
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
    @Query("reportType") reportType?: ReportTypeCode,
    @Query("status") status?: ReportStatus,
    @Query("studyId") studyId?: string,
  ): Promise<Report[]> {
    const params: ListReportsParams = { reportType, status, studyId };
    return this.reports.list(params);
  }

  @Get(":id")
  @RequirePermission("reportsDashboards", "read")
  getById(@Param("id") id: string): Promise<Report> {
    return this.reports.getById(id);
  }

  // Officer confirms (step 1 of two-step approval) — a `write`-level action,
  // distinct from the Reviewer's `approve` that follows.
  @Patch(":id/confirm")
  @RequirePermission("reportsDashboards", "write")
  confirm(@Param("id") id: string): Promise<Report> {
    return this.reports.confirm(id);
  }

  @Patch(":id/approve")
  @RequirePermission("reportsDashboards", "approve")
  approve(@Param("id") id: string): Promise<Report> {
    return this.reports.approve(id);
  }

  @Patch(":id/reject")
  @RequirePermission("reportsDashboards", "approve")
  reject(@Param("id") id: string): Promise<Report> {
    return this.reports.reject(id);
  }

  @Patch(":id/archive")
  @RequirePermission("reportsDashboards", "approve")
  archive(@Param("id") id: string): Promise<Report> {
    return this.reports.archive(id);
  }

  @Get(":id/export")
  @RequirePermission("reportsDashboards", "export")
  async export(@Param("id") id: string, @Query("format") format: ExportFormat, @Res() res: Response): Promise<void> {
    const file = await this.reports.export(id, format);
    res.set({
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.body.length),
    });
    res.end(file.body);
  }
}
