import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { parseIntParam } from "../../common/http/query.util";
import { TypeBoxValidationPipe } from "../../contract/validation.pipe";
import { CreateSharingRequestBody, DecideSharingRequestBody } from "./sharing.contract";
import { SharingService } from "./sharing.service";
import type {
  CreateSharingRequestPayload, DecideSharingRequestPayload, OrgLookupResult, SharedStudySnapshot,
  SharingRequest, StudyLookupResult,
} from "./sharing.types";

// Under archiveSharingAudit — currently read-only for most roles; ngo_admin
// (fullAccess) already has create/approve, matching the plan's "safe to add
// write/create/approve/share routes" note (no RBAC changes needed).
@Controller("sharing-requests")
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Post()
  @RequirePermission("archiveSharingAudit", "create")
  create(
    @Body(new TypeBoxValidationPipe(CreateSharingRequestBody)) body: CreateSharingRequestPayload,
  ): Promise<SharingRequest> {
    return this.sharing.create(body);
  }

  @Get()
  @RequirePermission("archiveSharingAudit", "read")
  list(@Query("limit") limit?: string, @Query("offset") offset?: string): Promise<SharingRequest[]> {
    return this.sharing.list({ limit: parseIntParam(limit), offset: parseIntParam(offset) });
  }

  // Declared ahead of the `:id` routes below so Nest matches these literal
  // paths first instead of treating "lookup" as an :id.
  @Get("lookup/organizations")
  @RequirePermission("archiveSharingAudit", "create")
  lookupOrganizations(@Query("query") query?: string): Promise<OrgLookupResult[]> {
    return this.sharing.lookupOrganizations(query);
  }

  @Get("lookup/organizations/:orgId/studies")
  @RequirePermission("archiveSharingAudit", "create")
  lookupStudiesForOrg(@Param("orgId") orgId: string): Promise<StudyLookupResult[]> {
    return this.sharing.lookupStudiesForOrg(orgId);
  }

  @Get(":id")
  @RequirePermission("archiveSharingAudit", "read")
  getById(@Param("id") id: string): Promise<SharingRequest> {
    return this.sharing.getById(id);
  }

  @Patch(":id/approve")
  @RequirePermission("archiveSharingAudit", "approve")
  approve(
    @Param("id") id: string,
    @Body(new TypeBoxValidationPipe(DecideSharingRequestBody)) body: DecideSharingRequestPayload,
  ): Promise<SharingRequest> {
    return this.sharing.approve(id, body ?? {});
  }

  @Patch(":id/reject")
  @RequirePermission("archiveSharingAudit", "approve")
  reject(
    @Param("id") id: string,
    @Body(new TypeBoxValidationPipe(DecideSharingRequestBody)) body: DecideSharingRequestPayload,
  ): Promise<SharingRequest> {
    return this.sharing.reject(id, body ?? {});
  }

  @Get(":id/shared-study")
  @RequirePermission("archiveSharingAudit", "read")
  getSharedSnapshot(@Param("id") id: string): Promise<SharedStudySnapshot> {
    return this.sharing.getSharedSnapshot(id);
  }
}
