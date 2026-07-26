import { Injectable } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor } from "../../tenancy/org-context";
import { can } from "../../rbac/role-matrix";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// A real queue, not a placeholder table — computed rather than stored, for
// both directions this now serves:
//  - Approver (anyone holding surveyBuilder:approve): the org-wide queue of
//    Surveys sitting in SUBMITTED awaiting their Approve/Reject — unchanged
//    from before, still no per-reviewer assignment (any of them acting on
//    an item removes it from everyone's queue, since it's the same row).
//  - Research Officer (surveyBuilder:write without :approve): their OWN
//    Surveys (Survey.createdBy) that just reached PUBLISHED/REJECTED —
//    "your survey was approved" / "changes requested". This used to be
//    invisible entirely (no notification at all); it also used to
//    accidentally show the Approver's SUBMITTED queue instead, because this
//    endpoint was gated on aiReview:read, a permission the Research Officer
//    holds for an unrelated reason (classification-decision parity, see
//    role-matrix.ts) — fixed by branching on the caller's actual
//    surveyBuilder capability instead of relying on a single fixed query.
// due-by/breach only makes sense for the still-open Approver queue; an
// already-resolved Research Officer alert has no SLA clock, so `dueAt`
// mirrors the resolution timestamp and `status` is always "pending"
// (meaning "unread", not "at risk"). In-app only, by product decision
// (RIO-FR-Add-04): the client confirmed email delivery is not required —
// the topbar bell's poll + severity-driven color (see useReviewerSlaBadge
// on the frontend) is the full "fires ahead of breach" mechanism for the
// Approver queue, not a placeholder for a future email channel.
@Injectable()
export class ReviewerSlaService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
  ) {}

  getConfig(): SlaConfig {
    return {
      slaHours: this.config.reviewerSlaHours,
      pollIntervalMs: this.config.reviewerSlaPollIntervalMs,
    };
  }

  async listAlerts(): Promise<SlaAlert[]> {
    const role = getOrgStore()?.role;
    return can(role, "surveyBuilder", "approve")
      ? this.listSurveyApprovalAlerts()
      : this.listOwnSurveyStatusAlerts();
  }

  // Approver-facing: Surveys awaiting THEIR decision, org-wide.
  private async listSurveyApprovalAlerts(): Promise<SlaAlert[]> {
    const slaMs = this.config.reviewerSlaHours * 60 * 60 * 1000;
    const now = Date.now();

    const { pendingSurveys, studies, needs } = await this.tenant.runInOrgContext(async (tx) => {
      const pendingSurveys = await tx.survey.findMany({
        where: { status: "SUBMITTED" },
        orderBy: { submittedAt: "asc" },
      });

      const studyIds = Array.from(new Set(pendingSurveys.map((s) => s.studyId)));
      const needIds = Array.from(new Set(pendingSurveys.map((s) => s.needId)));
      const [studyRows, needRows] = await Promise.all([
        tx.study.findMany({ where: { id: { in: studyIds } } }),
        tx.need.findMany({ where: { id: { in: needIds } } }),
      ]);
      return { pendingSurveys, studies: studyRows, needs: needRows };
    });

    const studyById = new Map(studies.map((s) => [s.id, s]));
    // Keyed by needId — a Study can have many Needs now, each with its own
    // pending survey, so this must resolve per-item, not collapse to "the"
    // Need for the Study.
    const needById = new Map(needs.map((n) => [n.id, n]));

    const statusFor = (dueAt: Date): SlaAlert["status"] => {
      const remainingMs = dueAt.getTime() - now;
      return remainingMs < 0 ? "breached" : remainingMs < slaMs * 0.25 ? "at_risk" : "pending";
    };

    const surveyApprovalAlerts: SlaAlert[] = pendingSurveys.map((survey) => {
      // submittedAt is always set once a survey reaches SUBMITTED (see
      // SurveysService.submitForApproval) — the `?? survey.updatedAt`
      // fallback is defensive only, never expected to trigger.
      const submittedAt = survey.submittedAt ?? survey.updatedAt;
      const dueAt = new Date(submittedAt.getTime() + slaMs);
      return {
        id: survey.id,
        type: "survey_approval",
        needId: survey.needId,
        studyId: survey.studyId,
        surveyId: survey.id,
        studyTitle: studyById.get(survey.studyId)?.title ?? survey.studyId,
        needStatement: needById.get(survey.needId)?.statement ?? null,
        touchpoint: "survey_approval",
        createdAt: submittedAt.toISOString(),
        dueAt: dueAt.toISOString(),
        status: statusFor(dueAt),
      };
    });

    return surveyApprovalAlerts.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  // Research Officer-facing: their own Surveys that just got resolved.
  private async listOwnSurveyStatusAlerts(): Promise<SlaAlert[]> {
    const actorId = requireActor();

    const { resolvedSurveys, studies, needs } = await this.tenant.runInOrgContext(async (tx) => {
      const resolvedSurveys = await tx.survey.findMany({
        where: { createdBy: actorId, status: { in: ["PUBLISHED", "REJECTED"] } },
        orderBy: { updatedAt: "desc" },
      });

      const studyIds = Array.from(new Set(resolvedSurveys.map((s) => s.studyId)));
      const needIds = Array.from(new Set(resolvedSurveys.map((s) => s.needId)));
      const [studyRows, needRows] = await Promise.all([
        tx.study.findMany({ where: { id: { in: studyIds } } }),
        tx.need.findMany({ where: { id: { in: needIds } } }),
      ]);
      return { resolvedSurveys, studies: studyRows, needs: needRows };
    });

    const studyById = new Map(studies.map((s) => [s.id, s]));
    const needById = new Map(needs.map((n) => [n.id, n]));

    const alerts: SlaAlert[] = resolvedSurveys.map((survey) => {
      const isApproved = survey.status === "PUBLISHED";
      // publishedAt/rejectedAt are always set on their respective
      // transitions (see SurveysService.approveAndPublish/rejectSurvey) —
      // the `?? updatedAt` fallback is defensive only.
      const resolvedAt = (isApproved ? survey.publishedAt : survey.rejectedAt) ?? survey.updatedAt;
      return {
        id: survey.id,
        type: isApproved ? "survey_approved" : "survey_rejected",
        needId: survey.needId,
        studyId: survey.studyId,
        surveyId: survey.id,
        studyTitle: studyById.get(survey.studyId)?.title ?? survey.studyId,
        needStatement: needById.get(survey.needId)?.statement ?? null,
        touchpoint: isApproved ? "survey_approved" : "survey_rejected",
        createdAt: resolvedAt.toISOString(),
        dueAt: resolvedAt.toISOString(),
        // No SLA clock applies to an already-resolved item — "pending" here
        // just means "unread" (see markReviewerSlaAlertsSeen on the frontend).
        status: "pending",
        comments: isApproved ? undefined : survey.approverComments,
      };
    });

    return alerts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
}
