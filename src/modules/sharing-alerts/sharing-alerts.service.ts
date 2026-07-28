import { Injectable } from "@nestjs/common";
import { requireOrgId } from "../../tenancy/org-context";
import { SharingService } from "../sharing/sharing.service";
import type { SharingRequest } from "../sharing/sharing.types";
import { ReportSharingService } from "../report-sharing/report-sharing.service";
import type { ReportSharingRequest } from "../report-sharing/report-sharing.types";
import type { SharingAlert } from "./sharing-alerts.types";

@Injectable()
export class SharingAlertsService {
  constructor(
    private readonly sharing: SharingService,
    private readonly reportSharing: ReportSharingService,
  ) {}

  async listAlerts(): Promise<SharingAlert[]> {
    const orgId = requireOrgId();
    // Both list() calls are already scoped to rows where the ambient org is
    // either the owner or the requester (see SharingService.list /
    // ReportSharingService.list) — no extra filtering needed to keep this
    // org-safe.
    const [studyRequests, reportRequests] = await Promise.all([
      this.sharing.list(),
      this.reportSharing.list(),
    ]);

    const studyAlerts = studyRequests.flatMap((row) => this.toAlerts(row, "study", orgId));
    const reportAlerts = reportRequests.flatMap((row) => this.toAlerts(row, "report", orgId));

    return [...studyAlerts, ...reportAlerts].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  private toAlerts(
    row: SharingRequest | ReportSharingRequest,
    entity: "study" | "report",
    orgId: string,
  ): SharingAlert[] {
    const title = "studyTitle" in row ? row.studyTitle : row.reportTitle;

    // Owner's incoming queue — disappears on its own once decided, since a
    // decided row is no longer `pending` (mirrors reviewer-sla's "same
    // underlying row leaves the queue once acted on").
    if (row.ownerOrgId === orgId && row.status === "pending") {
      return [
        {
          id: `${row.id}:created`,
          type: "request_created",
          entity,
          requestId: row.id,
          title,
          orgName: row.requestingOrgName,
          reason: null,
          createdAt: row.requestedAt,
        },
      ];
    }

    // Requester's outcome alert — persists in the DB forever, so the
    // frontend badge relies on localStorage seen-ids (same as reviewer-sla)
    // to stop counting it once viewed.
    if (row.requestingOrgId === orgId && row.decidedAt && (row.status === "approved" || row.status === "rejected")) {
      return [
        {
          id: `${row.id}:decided`,
          type: row.status === "approved" ? "request_approved" : "request_rejected",
          entity,
          requestId: row.id,
          title,
          orgName: row.ownerOrgName,
          reason: row.status === "rejected" ? row.decisionNote : null,
          createdAt: row.decidedAt,
        },
      ];
    }

    return [];
  }
}
