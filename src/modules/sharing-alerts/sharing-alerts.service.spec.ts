import { orgContext } from "../../tenancy/org-context";
import { SharingAlertsService } from "./sharing-alerts.service";
import type { SharingRequest } from "../sharing/sharing.types";
import type { ReportSharingRequest } from "../report-sharing/report-sharing.types";

function baseStudyRequest(overrides: Partial<SharingRequest> = {}): SharingRequest {
  return {
    id: "sr-1",
    ownerOrgId: "org-owner",
    ownerOrgName: "Owner NGO",
    requestingOrgId: "org-requester",
    requestingOrgName: "Requester NGO",
    studyId: "study-1",
    studyTitle: "Water Access Study",
    status: "pending",
    requestedBy: "user-1",
    requestedAt: "2026-07-20T10:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    note: "why",
    decisionNote: null,
    ...overrides,
  };
}

function baseReportRequest(overrides: Partial<ReportSharingRequest> = {}): ReportSharingRequest {
  return {
    id: "rsr-1",
    ownerOrgId: "org-owner",
    ownerOrgName: "Owner NGO",
    requestingOrgId: "org-requester",
    requestingOrgName: "Requester NGO",
    reportId: "report-1",
    reportTitle: "Village Needs Assessment",
    status: "pending",
    requestedBy: "user-1",
    requestedAt: "2026-07-20T10:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    note: "why",
    decisionNote: null,
    ...overrides,
  };
}

function fakeServices(studyRows: SharingRequest[], reportRows: ReportSharingRequest[]) {
  return {
    sharing: { list: async () => studyRows },
    reportSharing: { list: async () => reportRows },
  };
}

function runAsOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ requestId: "r", orgId, actorId: "user-x" }, fn);
}

describe("SharingAlertsService.listAlerts", () => {
  it("surfaces a pending incoming request as request_created for the owner org only", async () => {
    const { sharing, reportSharing } = fakeServices([baseStudyRequest()], []);
    const svc = new SharingAlertsService(sharing as never, reportSharing as never);

    const ownerAlerts = await runAsOrg("org-owner", () => svc.listAlerts());
    expect(ownerAlerts).toHaveLength(1);
    expect(ownerAlerts[0]).toMatchObject({ type: "request_created", entity: "study", orgName: "Requester NGO" });

    const requesterAlerts = await runAsOrg("org-requester", () => svc.listAlerts());
    expect(requesterAlerts).toHaveLength(0);
  });

  it("surfaces an approved decision as request_approved for the requesting org only", async () => {
    const row = baseStudyRequest({ status: "approved", decidedBy: "user-2", decidedAt: "2026-07-21T09:00:00.000Z" });
    const { sharing, reportSharing } = fakeServices([row], []);
    const svc = new SharingAlertsService(sharing as never, reportSharing as never);

    const requesterAlerts = await runAsOrg("org-requester", () => svc.listAlerts());
    expect(requesterAlerts).toHaveLength(1);
    expect(requesterAlerts[0]).toMatchObject({
      type: "request_approved", entity: "study", orgName: "Owner NGO", reason: null,
    });

    const ownerAlerts = await runAsOrg("org-owner", () => svc.listAlerts());
    expect(ownerAlerts).toHaveLength(0);
  });

  it("surfaces a rejected decision as request_rejected, carrying the reject reason", async () => {
    const row = baseStudyRequest({
      status: "rejected", decidedBy: "user-2", decidedAt: "2026-07-21T09:00:00.000Z",
      decisionNote: "Not relevant to current work",
    });
    const { sharing, reportSharing } = fakeServices([row], []);
    const svc = new SharingAlertsService(sharing as never, reportSharing as never);

    const requesterAlerts = await runAsOrg("org-requester", () => svc.listAlerts());
    expect(requesterAlerts).toHaveLength(1);
    expect(requesterAlerts[0]).toMatchObject({
      type: "request_rejected", reason: "Not relevant to current work",
    });
  });

  it("combines study and report alerts, sorted newest first", async () => {
    const oldReportRow = baseReportRequest({ id: "rsr-old" });
    const newStudyRow = baseStudyRequest({ id: "sr-new", requestedAt: "2026-07-22T10:00:00.000Z" });
    const { sharing, reportSharing } = fakeServices([newStudyRow], [oldReportRow]);
    const svc = new SharingAlertsService(sharing as never, reportSharing as never);

    const alerts = await runAsOrg("org-owner", () => svc.listAlerts());
    expect(alerts.map((a) => a.entity)).toEqual(["study", "report"]);
  });

  it("does not surface a still-pending outgoing request as anything (no premature alert before a decision)", async () => {
    const row = baseStudyRequest({ status: "pending" });
    const { sharing, reportSharing } = fakeServices([row], []);
    const svc = new SharingAlertsService(sharing as never, reportSharing as never);

    const requesterAlerts = await runAsOrg("org-requester", () => svc.listAlerts());
    expect(requesterAlerts).toHaveLength(0);
  });
});
