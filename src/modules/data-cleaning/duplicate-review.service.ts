import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { AuditService } from "../audit/audit.service";
import { isCrossOrgReader } from "./cross-org-reader";

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

    // Same oversight read as the findings queue. Note this does NOT widen Q9:
    // cross-ENTITY candidates carry org_id NULL and are already reachable only
    // through this supervisor path, never through an org-scoped one. What
    // changes here is that a platform-wide role can see each entity's OWN
    // pairs, which is the same data it can already read on that entity's
    // studies.
    const run = isCrossOrgReader()
      ? this.tenant.runAsSupervisor.bind(this.tenant)
      : this.tenant.runInOrgContext.bind(this.tenant);

    return run(async (tx) => {
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
   * RIO-AI-004 / Q9 — the cross-entity queue.
   *
   * Deliberately a SEPARATE method and a separate endpoint rather than a
   * filter on `list` above. Cross-entity rows carry org_id NULL and are only
   * reachable through the no-GUC supervisor path, so an entity-scoped caller
   * could not see them however it filtered — but relying on that alone would
   * mean the restriction lived in a WHERE clause an future edit could widen.
   * A distinct route lets the controller gate it on the role explicitly, so
   * both the policy and the permission have to fail before anything leaks.
   */
  async listCrossEntity(query: { page?: number; pageSize?: number }): Promise<{
    items: DuplicateCandidateItem[];
    total: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.DuplicateCandidateWhereInput = {
      scope: "cross_org",
      status: "pending",
    };

    return this.tenant.runAsSupervisor(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.duplicateCandidate.findMany({
          where,
          orderBy: [{ score: "desc" }, { detectedAt: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { aiSuggestion: { select: { reason: true } } },
        }),
        tx.duplicateCandidate.count({ where }),
      ]);

      const needIds = [...new Set(rows.flatMap((r) => [r.needAId, r.needBId]))];
      const orgIds = [...new Set(rows.flatMap((r) => [r.needAOrgId, r.needBOrgId]))];
      const [needs, orgs] = await Promise.all([
        needIds.length
          ? tx.need.findMany({
              where: { id: { in: needIds } },
              select: {
                id: true, internalRefSeq: true, title: true, statement: true,
                village: true, domain: true, subDomain: true, referenceId: true,
                orgId: true, createdAt: true,
              },
            })
          : [],
        orgIds.length
          ? tx.organisation.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
          : [],
      ]);
      const orgName = new Map(orgs.map((o) => [o.id, o.name]));
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
            // The owning ENTITY, not the study: on this queue the question a
            // reviewer is answering is "are these two entities recording the
            // same need?", so whose need it is has to be on screen.
            studyTitle: orgName.get(n.orgId) ?? null,
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

    // Same reasoning as FlagReviewService.review: a crossEntity role that can
    // see the pair must be able to decide it, and the write runs in the
    // owning entity's context so RLS and the audit trail both stay honest.
    const targetOrgId = await this.resolveCandidateOrg(candidateId, orgId);

    // A cross-entity pair carries org_id NULL, so no org-scoped connection can
    // reach it. The supervisor write path leaves the org GUC unset, and the
    // policy then reads as `org_id IS NOT DISTINCT FROM NULL` — which matches
    // the cross-entity rows and ONLY those. Every org-owned candidate stays
    // invisible on this path, so it confines the write rather than escaping it.
    const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      targetOrgId === null
        ? this.tenant.runAsSupervisorWrite(fn)
        : this.tenant.runAsOrg(targetOrgId, fn);

    const updated = await run(async (tx) => {
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
      // Null for a cross-entity pair: the decision is oversight acting above
      // both entities, and the reviewer's own entity is typically neither of
      // them. Passing null files it at platform level; passing undefined would
      // fall back to the reviewer's org, which is how the first version of
      // this got it wrong.
      organizationId: targetOrgId,
      changes: [
        { field: "Decision", before: "pending", after: decision },
        ...(targetOrgId === null
          ? [{ field: "Scope", before: null, after: "cross_entity" }]
          : []),
        { field: "Detected by", before: null, after: updated.method },
        { field: "Similarity", before: null, after: Number(updated.score) },
        { field: "Note", before: null, after: note?.trim() ?? null },
      ],
    });

    // A decided cross-entity pair is no longer in listCrossEntity (which shows
    // pending only), and the org-scoped list cannot see it at all, so there is
    // nothing to re-read — the row we just wrote is the answer.
    const refreshed =
      targetOrgId === null
        ? { items: [] as DuplicateCandidateItem[] }
        : await this.list({ status: updated.status, pageSize: 1 });
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

  /**
   * Which entity owns this pair — see FlagReviewService.resolveFlagOrg.
   *
   * Returns null for a cross-ENTITY pair, which has no owning org by design
   * (Q9). That is a real answer, not a miss: the caller has to pick a
   * different write path for it. An earlier version fell back to the actor own
   * org here, which put the update behind an RLS policy the row could never
   * satisfy and surfaced as a 404 on a pair the reviewer was looking at.
   */
  private async resolveCandidateOrg(
    candidateId: string,
    actorOrgId: string,
  ): Promise<string | null> {
    if (!isCrossOrgReader()) return actorOrgId;
    const row = await this.tenant.runAsSupervisor((tx) =>
      tx.duplicateCandidate.findUnique({ where: { id: candidateId }, select: { orgId: true } }),
    );
    return row?.orgId ?? null;
  }
}
