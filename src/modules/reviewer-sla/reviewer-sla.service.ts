import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// "Reviewer/Approver" in product terms is the `human_reviewer` role — the
// one that actually approves/modifies AI Classification before publishing,
// and the same role Study.assignedReviewerId is validated against
// (see StudiesService.resolveAssignedReviewer).
const REVIEWER_APPROVER_ROLE_KEY = roleByKey("human_reviewer")!.key;

// Real queue, not a placeholder table: "pending review" is simply every
// AiDecision row awaiting a human decision (humanDecision IS NULL).
// due-by is computed (createdAt + configurable SLA hours), not stored — no
// new table needed. In-app alerts only for now; a real email alert channel
// can stay a log-only placeholder later, same spirit as the temp-password
// email fallback already built for signup.
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

  // A Reviewer/Approver (human_reviewer) only ever sees their own assigned
  // queue — every other role (ngo_admin, center_supervisor, system_admin,
  // etc.) keeps the existing org-wide behavior unchanged. This is a
  // Study-level filter applied to the DB query itself (not a post-fetch
  // trim), so a Reviewer/Approver's session never even retrieves another
  // reviewer's AiDecision rows — a modified request/URL can't leak them.
  async listAlerts(): Promise<SlaAlert[]> {
    const slaMs = this.config.reviewerSlaHours * 60 * 60 * 1000;
    const now = Date.now();
    const isReviewerApprover = getOrgStore()?.role === REVIEWER_APPROVER_ROLE_KEY;
    const actorId = isReviewerApprover ? requireActor() : undefined;

    const { pending, studies, needs, reviewers } = await this.tenant.runInOrgContext(async (tx) => {
      const pendingRows = await tx.aiDecision.findMany({
        where: { humanDecision: { equals: Prisma.DbNull } },
        orderBy: { createdAt: "asc" },
      });
      const candidateStudyIds = Array.from(new Set(pendingRows.map((d) => d.studyId)));
      const studyRows = await tx.study.findMany({
        where: {
          id: { in: candidateStudyIds },
          ...(isReviewerApprover ? { assignedReviewerId: actorId } : {}),
        },
      });
      const studyIds = new Set(studyRows.map((s) => s.id));
      const scopedPending = isReviewerApprover ? pendingRows.filter((d) => studyIds.has(d.studyId)) : pendingRows;
      const needRows = await tx.need.findMany({ where: { studyId: { in: Array.from(studyIds) } } });
      const reviewerIds = Array.from(
        new Set(studyRows.map((s) => s.assignedReviewerId).filter((id): id is string => id !== null)),
      );
      const reviewerRows = reviewerIds.length > 0 ? await tx.user.findMany({ where: { id: { in: reviewerIds } } }) : [];
      return { pending: scopedPending, studies: studyRows, needs: needRows, reviewers: reviewerRows };
    });

    const studyById = new Map(studies.map((s) => [s.id, s]));
    const needByStudy = new Map(needs.map((n) => [n.studyId, n]));
    const reviewerById = new Map(reviewers.map((r) => [r.id, r]));

    return pending.map((decision) => {
      const dueAt = new Date(decision.createdAt.getTime() + slaMs);
      const remainingMs = dueAt.getTime() - now;
      const status = remainingMs < 0 ? "breached" : remainingMs < slaMs * 0.25 ? "at_risk" : "pending";
      const study = studyById.get(decision.studyId);
      const assignedReviewerId = study?.assignedReviewerId ?? null;
      return {
        aiDecisionId: decision.id,
        studyId: decision.studyId,
        studyTitle: study?.title ?? decision.studyId,
        needStatement: needByStudy.get(decision.studyId)?.statement ?? null,
        touchpoint: decision.touchpoint,
        createdAt: decision.createdAt.toISOString(),
        dueAt: dueAt.toISOString(),
        status,
        assignedReviewerId,
        assignedReviewerName: assignedReviewerId ? (reviewerById.get(assignedReviewerId)?.name ?? null) : null,
      };
    });
  }

}
