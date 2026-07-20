import { Controller, Get, Query } from "@nestjs/common";
import { RequirePermission } from "../../common/guards/permission.guard";
import { ArchiveService } from "./archive.service";
import type { ArchiveEntry, ArchiveEntryKind } from "./archive.types";

@Controller("archive")
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Get()
  @RequirePermission("archiveSharingAudit", "read")
  list(
    @Query("kind") kind?: ArchiveEntryKind,
    @Query("search") search?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("organizationId") organizationId?: string,
    @Query("region") region?: string,
    @Query("sector") sector?: string,
    @Query("village") village?: string,
  ): Promise<ArchiveEntry[]> {
    return this.archive.list({ kind, search, dateFrom, dateTo, organizationId, region, sector, village });
  }
}
