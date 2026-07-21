import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// Real queues, not a placeholder table — two of them, both computed rather
// than stored: an AiDecision row awaiting a human decision (humanDecision IS
// NULL), and a Survey sitting in SUBMITTED awaiting the Approver's
// Approve/Reject (see SurveysService's state machine). There is no concept
// of assigning either to a specific reviewer — any user with the
// Reviewer/Approver (human_reviewer) role sees the same org-wide pending
// queue, and once any one of them acts on an item (AiDecisionsService.review
// / SurveysService.approveAndPublish|rejectSurvey), it disappears from
// everyone's queue since it's the same underlying row. due-by is computed
// (createdAt/submittedAt + configurable SLA hours), not stored — no new
// table needed. In-app alerts only for now; a real email alert channel can
// stay a log-only placeholder later, same spirit as the temp-password email
// fallback already built for signup.
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

    const { pendingDecisions, pendingSurveys, studies, needs } = await this.tenant.runInOrgContext(
      async (tx) => {
        const [pendingDecisions, pendingSurveys] = await Promise.all([
          tx.aiDecision.findMany({
            where: { humanDecision: { equals: Prisma.DbNull } },
            orderBy: { createdAt: "asc" },
          }),
          tx.survey.findMany({
            where: { status: "SUBMITTED" },
            orderBy: { submittedAt: "asc" },
          }),
        ]);
        const studyIds = Array.from(
          new Set([...pendingDecisions.map((d) => d.studyId), ...pendingSurveys.map((s) => s.studyId)]),
        );
        const needIds = Array.from(
          new Set([...pendingDecisions.map((d) => d.needId), ...pendingSurveys.map((s) => s.needId)]),
        );
        const [studyRows, needRows] = await Promise.all([
          tx.study.findMany({ where: { id: { in: studyIds } } }),
          tx.need.findMany({ where: { id: { in: needIds } } }),
        ]);
        return { pendingDecisions, pendingSurveys, studies: studyRows, needs: needRows };
      },
    );

    const studyById = new Map(studies.map((s) => [s.id, s]));
    // Keyed by needId — a Study can have many Needs now, each with its own
    // pending classification/survey, so this must resolve per-item, not
    // collapse to "the" Need for the Study.
    const needById = new Map(needs.map((n) => [n.id, n]));

    const statusFor = (dueAt: Date): SlaAlert["status"] => {
      const remainingMs = dueAt.getTime() - now;
      return remainingMs < 0 ? "breached" : remainingMs < slaMs * 0.25 ? "at_risk" : "pending";
    };

    const classificationAlerts: SlaAlert[] = pendingDecisions.map((decision) => {
      const dueAt = new Date(decision.createdAt.getTime() + slaMs);
      return {
        id: decision.id,
        type: "ai_classification",
        needId: decision.needId,
        studyId: decision.studyId,
        surveyId: null,
        studyTitle: studyById.get(decision.studyId)?.title ?? decision.studyId,
        needStatement: needById.get(decision.needId)?.statement ?? null,
        touchpoint: decision.touchpoint,
        createdAt: decision.createdAt.toISOString(),
        dueAt: dueAt.toISOString(),
        status: statusFor(dueAt),
      };
    });

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

    return [...classificationAlerts, ...surveyApprovalAlerts].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
}
