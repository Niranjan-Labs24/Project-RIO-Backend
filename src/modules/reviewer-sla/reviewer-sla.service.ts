import { Injectable } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// A real queue, not a placeholder table — computed rather than stored.
// `survey_approval` only: a Survey sitting in SUBMITTED awaiting the
// Approver's Approve/Reject (see SurveysService's state machine). A Need
// reaching `ai_classified` no longer produces its own separate alert here —
// product decision: the Approver's queue is driven entirely by the
// Researcher's explicit "Submit for Review" action (Survey DRAFT ->
// SUBMITTED), not by AI classification completing automatically in the
// background. A Need can sit at `ai_classified` for a while with nothing
// showing up here; that's expected, not a bug — it only surfaces once
// Submit for Review is actually clicked. Overriding/approving the
// classification itself (AiDecisionsService.approveAiReview/rejectAiReview)
// is still gated on `ai_classified` as before; this only changes what shows
// up as a queue item.
// There is no concept of assigning an item to a specific reviewer — any user
// with the Reviewer/Approver (human_reviewer) role sees the same org-wide
// pending queue, and once any one of them acts on an item, it disappears
// from everyone's queue since it's the same underlying row. due-by is
// computed (createdAt/submittedAt + configurable SLA hours), not stored —
// no new table needed. In-app only, by product decision (RIO-FR-Add-04):
// the client confirmed email delivery is not required — the topbar bell's
// poll + severity-driven color (see useReviewerSlaBadge on the frontend)
// is the full "fires ahead of breach" mechanism, not a placeholder for a
// future email channel.
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
}
