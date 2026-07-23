import { Injectable } from "@nestjs/common";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// A real queue, not a placeholder table — computed rather than stored, from
// two independent sources that share the one SlaAlert shape (see
// reviewer-sla.types.ts):
//   - `ai_classification`: a Need at `ai_classified` whose latest AiDecision
//     still has `humanDecision: null` — awaiting the Approver's
//     Approve/Override/Reject (see AiDecisionsService.approveAiReview/
//     rejectAiReview). This is now the Approver's own job (see
//     role-matrix.ts's role_human_reviewer — `aiReview: { approve: true }`),
//     not the Researcher's, since this session's workflow merge.
//   - `survey_approval`: a Survey sitting in SUBMITTED awaiting the
//     Approver's Approve/Reject via the legacy manual-survey path (see
//     SurveysService's state machine) — still possible alongside the
//     now-atomic AI-review Approve, which publishes the survey directly.
// There is no concept of assigning an item to a specific reviewer — any user
// with the Reviewer/Approver (human_reviewer) role sees the same org-wide
// pending queue, and once any one of them acts on an item, it disappears
// from everyone's queue since it's the same underlying row. due-by is
// computed (createdAt/submittedAt + configurable SLA hours), not stored —
// no new table needed. In-app alerts only for now; a real email alert
// channel can stay a log-only placeholder later, same spirit as the
// temp-password email fallback already built for signup.
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

    const { pendingSurveys, undecidedDecisions, studies, needs } =
      await this.tenant.runInOrgContext(async (tx) => {
        const [pendingSurveys, classifiedNeeds] = await Promise.all([
          tx.survey.findMany({
            where: { status: "SUBMITTED" },
            orderBy: { submittedAt: "asc" },
          }),
          tx.need.findMany({ where: { status: "ai_classified" } }),
        ]);

        // One live AiDecision per ai_classified Need is the invariant this
        // relies on — AiDecisionsService.review rejects a second review of
        // an already-decided row, and a rejection moves the Need off
        // ai_classified entirely (back to pending_ai_classification), so
        // there's never more than one undecided row per Need to find here.
        const classifiedNeedIds = classifiedNeeds.map((n) => n.id);
        const decisions =
          classifiedNeedIds.length === 0
            ? []
            : await tx.aiDecision.findMany({
                where: { needId: { in: classifiedNeedIds } },
                orderBy: { createdAt: "desc" },
              });
        const undecidedByNeedId = new Map<string, (typeof decisions)[number]>();
        for (const decision of decisions) {
          if (decision.humanDecision !== null) continue;
          if (!undecidedByNeedId.has(decision.needId)) {
            undecidedByNeedId.set(decision.needId, decision);
          }
        }
        const undecidedDecisions = Array.from(undecidedByNeedId.values());

        const studyIds = Array.from(
          new Set([
            ...pendingSurveys.map((s) => s.studyId),
            ...undecidedDecisions.map((d) => d.studyId),
          ]),
        );
        const needIds = Array.from(
          new Set([
            ...pendingSurveys.map((s) => s.needId),
            ...undecidedDecisions.map((d) => d.needId),
          ]),
        );
        const [studyRows, needRows] = await Promise.all([
          tx.study.findMany({ where: { id: { in: studyIds } } }),
          tx.need.findMany({ where: { id: { in: needIds } } }),
        ]);
        return { pendingSurveys, undecidedDecisions, studies: studyRows, needs: needRows };
      });

    const studyById = new Map(studies.map((s) => [s.id, s]));
    // Keyed by needId — a Study can have many Needs now, each with its own
    // pending survey/classification, so this must resolve per-item, not
    // collapse to "the" Need for the Study.
    const needById = new Map(needs.map((n) => [n.id, n]));

    const statusFor = (dueAt: Date): SlaAlert["status"] => {
      const remainingMs = dueAt.getTime() - now;
      return remainingMs < 0 ? "breached" : remainingMs < slaMs * 0.25 ? "at_risk" : "pending";
    };

    const aiClassificationAlerts: SlaAlert[] = undecidedDecisions.map((decision) => {
      const createdAt = decision.createdAt;
      const dueAt = new Date(createdAt.getTime() + slaMs);
      return {
        id: decision.id,
        type: "ai_classification",
        needId: decision.needId,
        studyId: decision.studyId,
        surveyId: null,
        studyTitle: studyById.get(decision.studyId)?.title ?? decision.studyId,
        needStatement: needById.get(decision.needId)?.statement ?? null,
        touchpoint: decision.touchpoint,
        createdAt: createdAt.toISOString(),
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

    return [...aiClassificationAlerts, ...surveyApprovalAlerts].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
}
