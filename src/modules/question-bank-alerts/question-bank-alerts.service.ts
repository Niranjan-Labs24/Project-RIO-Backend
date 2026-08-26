import { Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore } from "../../tenancy/org-context";
import type { QuestionBankAlert, QuestionBankAlertChangeKind } from "./question-bank-alerts.types";

// methodologyQuestionBank:read is held far more broadly than just the two
// reviewer roles (Research Officer, Field Researcher, Data Analyst,
// read_only_viewer, and center_supervisor all hold it too, per
// role-matrix.ts) — those roles are browsing the bank, not reviewing
// changes to it, so the controller's guard alone isn't a tight enough
// filter. This is the actual gate on who gets the feed.
const ALERT_VISIBLE_ROLES = new Set(["human_reviewer", "system_reviewer"]);

// Human Reviewer (methodologyQuestionBank:approve) and System Reviewer
// (methodologyQuestionBank: read-only) both land on this single feed — every
// Question Bank mutation (create/edit/deactivate/reactivate) already goes
// through QuestionsService.createPendingVersion/create, which lands the
// change as a `pending_approval` row (see questions.service.ts). That row IS
// the alert; there is no separate event log to maintain. System Reviewer
// can't act on it (no `approve` grant) but still needs visibility, the same
// way ReviewerSlaService serves a read-only queue to a role that can't act.
@Injectable()
export class QuestionBankAlertsService {
  constructor(private readonly tenant: TenantPrismaService) {}

  async listAlerts(): Promise<QuestionBankAlert[]> {
    const role = getOrgStore()?.role;
    if (!role || !ALERT_VISIBLE_ROLES.has(role)) return [];

    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.question.findMany({
        where: { approvalStatus: "pending_approval" },
        orderBy: { submittedAt: "asc" },
      }),
    );

    return rows.map((r) => ({
      id: `${r.id}:pending`,
      type: "question_pending_approval" as const,
      changeKind: this.changeKindFor(r),
      questionRowId: r.id,
      questionId: r.questionId,
      questionText: r.questionText,
      domain: r.domain,
      subDomain: r.subDomain,
      // submittedAt is always set once a row enters pending_approval (see
      // createPendingVersion/create) — no fallback needed.
      submittedAt: r.submittedAt!.toISOString(),
    }));
  }

  // Derived straight off the pending row itself, no extra lookup: a brand
  // new question has no previousVersionId; everything else is an edit of an
  // existing one, and isActive tells apart a plain edit from a
  // deactivate/reactivate request (the only two mutations that ever flip it).
  private changeKindFor(r: {
    previousVersionId: string | null;
    isActive: boolean;
  }): QuestionBankAlertChangeKind {
    if (r.previousVersionId === null) return "created";
    return r.isActive ? "edited" : "deactivated";
  }
}
