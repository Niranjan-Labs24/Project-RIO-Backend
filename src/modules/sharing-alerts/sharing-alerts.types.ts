// Three event kinds, computed from the existing SharingRequest /
// ReportSharingRequest rows — no stored Notification model, same "real
// queue, computed not stored" approach as reviewer-sla (see
// reviewer-sla.service.ts). `request_created` is the owner org's incoming
// queue (naturally empties once decided, since the query only looks at
// `pending` rows); `request_approved`/`request_rejected` are the requesting
// org's outcome alerts (persist forever in the DB, so the frontend badge
// hides seen ones via the same localStorage seen-ids pattern
// use-reviewer-sla-badge.ts already uses).
export type SharingAlertType = "request_created" | "request_approved" | "request_rejected";
export type SharingAlertEntity = "study" | "report";

export interface SharingAlert {
  id: string;
  type: SharingAlertType;
  entity: SharingAlertEntity;
  requestId: string;
  title: string;
  orgName: string;
  reason: string | null;
  createdAt: string;
}
