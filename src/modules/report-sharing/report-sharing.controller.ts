import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { RequirePermission } from "../../common/guards/permission.guard";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import type { ExportFormat } from "../reports/reports.types";
import { CreateReportSharingRequestBody, DecideReportSharingRequestBody } from "./report-sharing.contract";
import { ReportSharingService } from "./report-sharing.service";
import type {
  CreateReportSharingRequestPayload, DecideReportSharingRequestPayload, OrgLookupResult,
  ReportLookupResult, ReportSharingRequest, SharedReportSnapshot,
} from "./report-sharing.types";

// Same permission module as Study-sharing (archiveSharingAudit) — one
// "Sharing" concept in the role matrix, covering both entity types.
@Controller("report-sharing-requests")
export class ReportSharingController {
  constructor(private readonly reportSharing: ReportSharingService) {}

  @Post()
  @RequirePermission("archiveSharingAudit", "create")
  create(
    @Body(new TypeBoxValidationPipe(CreateReportSharingRequestBody)) body: CreateReportSharingRequestPayload,
  ): Promise<ReportSharingRequest> {
    return this.reportSharing.create(body);
  }

  @Get()
  @RequirePermission("archiveSharingAudit", "read")
  list(): Promise<ReportSharingRequest[]> {
    return this.reportSharing.list();
  }

  // Declared ahead of the `:id` routes below so Nest matches these literal
  // paths first instead of treating "lookup" as an :id.
  @Get("lookup/organizations")
  @RequirePermission("archiveSharingAudit", "create")
  lookupOrganizations(@Query("query") query?: string): Promise<OrgLookupResult[]> {
    return this.reportSharing.lookupOrganizations(query);
  }

  @Get("lookup/organizations/:orgId/reports")
  @RequirePermission("archiveSharingAudit", "create")
  lookupReportsForOrg(@Param("orgId") orgId: string): Promise<ReportLookupResult[]> {
    return this.reportSharing.lookupReportsForOrg(orgId);
  }

  @Get(":id")
  @RequirePermission("archiveSharingAudit", "read")
  getById(@Param("id") id: string): Promise<ReportSharingRequest> {
    return this.reportSharing.getById(id);
  }

  @Patch(":id/approve")
  @RequirePermission("archiveSharingAudit", "approve")
  approve(
    @Param("id") id: string,
    @Body(new TypeBoxValidationPipe(DecideReportSharingRequestBody)) body: DecideReportSharingRequestPayload,
  ): Promise<ReportSharingRequest> {
    return this.reportSharing.approve(id, body ?? {});
  }

  @Patch(":id/reject")
  @RequirePermission("archiveSharingAudit", "approve")
  reject(
    @Param("id") id: string,
    @Body(new TypeBoxValidationPipe(DecideReportSharingRequestBody)) body: DecideReportSharingRequestPayload,
  ): Promise<ReportSharingRequest> {
    return this.reportSharing.reject(id, body ?? {});
  }

  @Get(":id/shared-report")
  @RequirePermission("archiveSharingAudit", "read")
  getSharedSnapshot(@Param("id") id: string): Promise<SharedReportSnapshot> {
    return this.reportSharing.getSharedSnapshot(id);
  }

  @Get(":id/export")
  @RequirePermission("archiveSharingAudit", "read")
  async export(@Param("id") id: string, @Query("format") format: ExportFormat, @Res() res: Response): Promise<void> {
    const file = await this.reportSharing.exportSharedReport(id, format);
    res.set({
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.body.length),
    });
    res.end(file.body);
  }
}
