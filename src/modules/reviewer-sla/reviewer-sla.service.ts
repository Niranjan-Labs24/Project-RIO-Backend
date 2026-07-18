import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { ConfigService } from "../../config/config.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import type { SlaAlert, SlaConfig } from "./reviewer-sla.types";

// Real queue, not a placeholder table: "pending review" is simply every
// AiDecision row awaiting a human decision (humanDecision IS NULL). There is
// no concept of assigning a Study to a specific reviewer — any user with
// the Reviewer/Approver (human_reviewer) role sees the same org-wide
// pending queue, and once any one of them reviews an item (see
// AiDecisionsService.review, which stamps decidedBy/decidedAt), it
// disappears from everyone's queue since it's the same underlying row.
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

  async listAlerts(): Promise<SlaAlert[]> {
    const slaMs = this.config.reviewerSlaHours * 60 * 60 * 1000;
    const now = Date.now();

    const { pending, studies, needs } = await this.tenant.runInOrgContext(async (tx) => {
      const pendingRows = await tx.aiDecision.findMany({
        where: { humanDecision: { equals: Prisma.DbNull } },
        orderBy: { createdAt: "asc" },
      });
      const studyIds = Array.from(new Set(pendingRows.map((d) => d.studyId)));
      const [studyRows, needRows] = await Promise.all([
        tx.study.findMany({ where: { id: { in: studyIds } } }),
        tx.need.findMany({ where: { studyId: { in: studyIds } } }),
      ]);
      return { pending: pendingRows, studies: studyRows, needs: needRows };
    });

    const studyById = new Map(studies.map((s) => [s.id, s]));
    const needByStudy = new Map(needs.map((n) => [n.studyId, n]));

    return pending.map((decision) => {
      const dueAt = new Date(decision.createdAt.getTime() + slaMs);
      const remainingMs = dueAt.getTime() - now;
      const status = remainingMs < 0 ? "breached" : remainingMs < slaMs * 0.25 ? "at_risk" : "pending";
      return {
        aiDecisionId: decision.id,
        studyId: decision.studyId,
        studyTitle: studyById.get(decision.studyId)?.title ?? decision.studyId,
        needStatement: needByStudy.get(decision.studyId)?.statement ?? null,
        touchpoint: decision.touchpoint,
        createdAt: decision.createdAt.toISOString(),
        dueAt: dueAt.toISOString(),
        status,
      };
    });
  }
}
