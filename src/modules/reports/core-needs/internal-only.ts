// Village scope is for internal reports only (client, 15 Oct 2026; confirmed
// 20 Oct 2026): a Core Needs Report generated at village level can be viewed
// and exported by its own organisation, but never listed in the shared
// catalogue or shared with another organisation. One definition, used by the
// catalogue toggle, the catalogue listing and every report-sharing step.

import { BadRequestException } from "@nestjs/common";

interface ReportLike {
  reportType: string;
  filters?: unknown;
}

export function isInternalOnlyReport(report: ReportLike): boolean {
  if (report.reportType !== "RPT18") return false;
  const filters = report.filters as { scopeLevel?: unknown } | null | undefined;
  return filters?.scopeLevel === "VILLAGE";
}

/** Prisma `where` fragment that leaves village-level Core Needs Reports out. */
export const NOT_INTERNAL_ONLY = {
  NOT: { AND: [{ reportType: "RPT18" as const }, { filters: { path: ["scopeLevel"], equals: "VILLAGE" } }] },
};

export function assertShareable(report: ReportLike): void {
  if (isInternalOnlyReport(report)) {
    throw new BadRequestException({
      error: {
        code: "VILLAGE_REPORT_INTERNAL",
        message: "Village-level reports are for internal use only and cannot be shared or listed in the catalogue.",
      },
    });
  }
}
