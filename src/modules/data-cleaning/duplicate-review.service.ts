import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { AuditService } from "../audit/audit.service";

/**
 * RIO-FR-002 — the shared duplicate queue of Q40, reader and decision side.
 *
 * What a decision means HERE, and what it deliberately does not:
 *
 *   not_duplicate       — these two needs are different. Closed, logged, done.
 *   confirmed_duplicate — these two ARE the same need. Recorded and logged.
 *                         It does NOT merge them.
 *
 * That second boundary is the client's, not ours. FR-002's acceptance
 * criterion is "duplicates are proposed for review WITHOUT automatic merging"
 * and "reviewer decision is logged" — both satisfied by recording the
 * decision. The merge action itself, and everything Q50/Q51 say has to happen
 * when one runs (survey responses, evidence, AI decisions and initiative links
 * transferring with their provenance; the retired reference surviving as an
 * alias; scores recalculating; published reports staying frozen; undo with a
 * mandatory note), is RIO-AI-004. Building a merge button here that did less
 * than that would lose data the client has already told us must move.
 *
 * So a confirmed duplicate sits in the queue as confirmed, and AI-004's merge
 * screen picks it up from there.
 */

const DEFAULT_PAGE_SIZE = 25;

export interface DuplicateNeedSummary {
  id: string;
  reference: string;
  title: string;
  statement: string;
  village: string[];
  domain: string | null;
  subDomain: string | null;
  referenceId: string | null;
  studyTitle: string | null;
  createdAt: Date;
}

export interface DuplicateCandidateItem {
  id: string;
  scope: string;
  method: string;
  score: number;
  threshold: number;
  status: string;
  note: string | null;
  reviewedAt: Date | null;
  detectedAt: Date;
  /** The AI's stated reason, for a semantic candidate. Null for literal ones. */
  aiReason: string | null;
  needA: DuplicateNeedSummary | null;
  needB: DuplicateNeedSummary | null;
}

@Injectable()
export class DuplicateReviewService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: {
    status?: string;
    method?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: DuplicateCandidateItem[]; total: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.DuplicateCandidateWhereInput = {
      status: query.status ?? "pending",
      ...(query.method ? { method: query.method } : {}),
    };

    return this.tenant.runInOrgContext(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.duplicateCandidate.findMany({
          where,
          // Strongest match first: the reviewer's time is best spent where the
          // system is most confident, and a queue sorted by date buries those.
          orderBy: [{ score: "desc" }, { detectedAt: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { aiSuggestion: { select: { reason: true } } },
        }),
        tx.duplicateCandidate.count({ where }),
      ]);

      const needIds = [...new Set(rows.flatMap((r) => [r.needAId, r.needBId]))];
      const needs = needIds.length
        ? await tx.need.findMany({
            where: { id: { in: needIds } },
            select: {
              id: true,
              internalRefSeq: true,
              title: true,
              statement: true,
              village: true,
              domain: true,
              subDomain: true,
              referenceId: true,
              createdAt: true,
              study: { select: { title: true } },
            },
          })
        : [];
      const byId = new Map(
        needs.map((n) => [
          n.id,
          {
            id: n.id,
            reference: `NEED-${String(n.internalRefSeq).padStart(6, "0")}`,
            title: n.title,
            statement: n.statement,
            village: n.village,
            domain: n.domain,
            subDomain: n.subDomain,
            referenceId: n.referenceId,
            studyTitle: n.study?.title ?? null,
            createdAt: n.createdAt,
          } satisfies DuplicateNeedSummary,
        ]),
      );

      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          method: row.method,
          score: Number(row.score),
          threshold: Number(row.threshold),
          status: row.status,
          note: row.note,
          reviewedAt: row.reviewedAt,
          detectedAt: row.detectedAt,
          aiReason: row.aiSuggestion?.reason ?? null,
          needA: byId.get(row.needAId) ?? null,
          needB: byId.get(row.needBId) ?? null,
        })),
      };
    });
  }

  /**
   * Record a reviewer's decision on a proposed pair (AC 3 and AC 4).
   *
   * A note is required for "not a duplicate": that decision permanently
   * suppresses a pair the system believed matched, and a later reader looking
   * at two near-identical needs needs to know someone examined them and why
   * they are different. Confirming a duplicate needs no note — the pair itself
   * is the evidence, and AI-004's merge will require its own.
   */
  async decide(
    candidateId: string,
    decision: "confirmed_duplicate" | "not_duplicate",
    note: string | undefined,
  ): Promise<DuplicateCandidateItem> {
    const orgId = requireOrgId();
    const actor = requireActor();

    if (decision === "not_duplicate" && !note?.trim()) {
      throw new BadRequestException({
        error: {
          code: "NOTE_REQUIRED",
          message: "A note is required when dismissing a proposed duplicate.",
        },
      });
    }

    const updated = await this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.duplicateCandidate.findUnique({ where: { id: candidateId } });
      if (!existing) {
        throw new NotFoundException({
          error: { code: "CANDIDATE_NOT_FOUND", message: "Duplicate candidate not found." },
        });
      }
      if (existing.status !== "pending") {
        throw new BadRequestException({
          error: {
            code: "CANDIDATE_ALREADY_DECIDED",
            message: `This pair was already marked ${existing.status.replace("_", " ")}.`,
          },
        });
      }
      return tx.duplicateCandidate.update({
        where: { id: candidateId },
        data: {
          status: decision,
          reviewedBy: actor,
          reviewedAt: new Date(),
          note: note?.trim() || null,
        },
      });
    });

    await this.audit.record({
      action: "review_duplicate_candidate",
      entityType: "duplicate_candidate",
      entityId: updated.id,
      entityLabel: `${decision === "confirmed_duplicate" ? "Confirmed" : "Dismissed"} duplicate pair`,
      organizationId: orgId,
      changes: [
        { field: "Decision", before: "pending", after: decision },
        { field: "Detected by", before: null, after: updated.method },
        { field: "Similarity", before: null, after: Number(updated.score) },
        { field: "Note", before: null, after: note?.trim() ?? null },
      ],
    });

    const refreshed = await this.list({ status: updated.status, pageSize: 1 });
    return (
      refreshed.items.find((item) => item.id === updated.id) ?? {
        id: updated.id,
        scope: updated.scope,
        method: updated.method,
        score: Number(updated.score),
        threshold: Number(updated.threshold),
        status: updated.status,
        note: updated.note,
        reviewedAt: updated.reviewedAt,
        detectedAt: updated.detectedAt,
        aiReason: null,
        needA: null,
        needB: null,
      }
    );
  }
}
