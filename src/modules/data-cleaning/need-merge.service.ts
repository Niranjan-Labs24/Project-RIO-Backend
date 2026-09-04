import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma";
import { getOrgStore, orgContext, requireActor, requireOrgId } from "../../tenancy/org-context";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { AuditService } from "../audit/audit.service";
import { PriorityService } from "../priority/priority.service";
import { isCrossOrgReader } from "./cross-org-reader";

/**
 * RIO-AI-004 — turning a confirmed duplicate pair into one need.
 *
 * FR-002 gets a pair as far as `confirmed_duplicate`. This performs the merge
 * the client described, and nothing else in the codebase may: it is the only
 * place a Need is retired.
 *
 * ─── The rules this implements, and where they come from ───────────────────
 *   Q49  operates on the ENTERED need. `priority_scores` is deliberately NOT
 *        transferred — those are computed rows belonging to the need that was
 *        scored, and the client explicitly excluded them.
 *   Q50  everything else transfers, with its origin recorded (the ledger).
 *   Q51  the survivor keeps its OWN internal reference; the retired number
 *        becomes a permanent alias; both external references are retained.
 *   Q24  published reports stay frozen, current scores recalculate, undo is
 *        allowed with a mandatory note.
 *   Q11  nothing here runs without an explicit human decision.
 *
 * And their closing note on Q51, which governs everything: "make sure no entry
 * overrides another one." No need is deleted, no reference is overwritten, and
 * every transfer is reversible.
 */

/**
 * Everything a merge moves, in the order it is moved.
 *
 * Derived from the Need model's own relations, minus two deliberate
 * exclusions:
 *
 *   needDomains / needGovernorates / needCenters — the need's OWN
 *     classification and geography. The survivor has its own; copying the
 *     retired need's would silently widen what the survivor claims to cover.
 *   priorityScores — computed severity for the retired need (Q49). The
 *     survivor's are recalculated instead, which is Q24's instruction.
 *
 * Child rows that hang off a transferred row rather than off the need
 * (ResponseAnswer and ResponseSeverityScore key on surveyResponseId,
 * HumanDecision on aiSuggestionId, NeedDecisionStatusEvent on decisionId)
 * follow their parent automatically and are not listed.
 */
const TRANSFERABLE = [
  { model: "SurveyResponse", delegate: "surveyResponse" },
  { model: "Evidence", delegate: "evidence" },
  { model: "AiDecision", delegate: "aiDecision" },
  { model: "AiSuggestion", delegate: "aiSuggestion" },
  { model: "AiSummary", delegate: "aiSummary" },
  { model: "NeedStatementSummary", delegate: "needStatementSummary" },
  { model: "NeedDecision", delegate: "needDecision" },
  { model: "Survey", delegate: "survey" },
  { model: "PublicSurveyLink", delegate: "publicSurveyLink" },
  { model: "SurveySession", delegate: "surveySession" },
  { model: "ResponseQualityResult", delegate: "responseQualityResult" },
] as const;

export interface MergeHistoryItem {
  id: string;
  survivor: { id: string; reference: string; title: string } | null;
  retired: { id: string; reference: string; title: string } | null;
  transferredCount: number;
  note: string | null;
  decidedAt: Date;
  decidedByName: string | null;
  undoneAt: Date | null;
  undoneByName: string | null;
  undoNote: string | null;
  /** False once undone — a merge is reversed once, not repeatedly. */
  canUndo: boolean;
}

export interface MergePreview {
  survivor: { id: string; reference: string; title: string; referenceId: string | null };
  retired: { id: string; reference: string; title: string; referenceId: string | null };
  /** What moves, by model, with counts. The reviewer confirms THIS. */
  transfers: { entityType: string; count: number }[];
  totalTransfers: number;
  /** The retired number, which keeps resolving to the survivor afterwards. */
  aliasedReference: string;
  /** External references the survivor will carry after the merge. */
  externalReferences: string[];
  /** Published reports naming either need — frozen, never rewritten (Q24). */
  frozenReportCount: number;
  /** Scores that will be recalculated for the survivor (Q24). */
  scoresToRecalculate: number;
  /**
   * Warnings as CODES, not prose. This platform is Arabic-first and the merge
   * dialog is translated — an English sentence built on the server would be
   * the one untranslated string on the screen. The client renders these.
   */
  warnings: { code: string; count?: number }[];
}

function formatReference(seq: number): string {
  return `NEED-${String(seq).padStart(6, "0")}`;
}

@Injectable()
export class NeedMergeService {
  private readonly logger = new Logger(NeedMergeService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly priority: PriorityService,
  ) {}

  /**
   * What a merge would do, without doing it.
   *
   * This is the answer to Q24's "are there any examples on these scenarios?" —
   * the reviewer confirms a described outcome rather than a guess, and the
   * same description can be shown to the client as a worked example.
   */
  async preview(survivorNeedId: string, retiredNeedId: string): Promise<MergePreview> {
    const run = isCrossOrgReader()
      ? this.tenant.runAsSupervisor.bind(this.tenant)
      : this.tenant.runInOrgContext.bind(this.tenant);
    return run(async (tx) => {
      const { survivor, retired } = await this.loadPair(tx, survivorNeedId, retiredNeedId);

      const transfers: { entityType: string; count: number }[] = [];
      let totalTransfers = 0;
      for (const entry of TRANSFERABLE) {
        const count = await this.countFor(tx, entry.delegate, retiredNeedId);
        if (count > 0) {
          transfers.push({ entityType: entry.model, count });
          totalTransfers += count;
        }
      }

      const [frozenReportCount, scoresToRecalculate] = await Promise.all([
        // "released" is this platform's published state (see the ReportStatus
        // enum). Q24: these stay frozen as historical record — a merge never
        // rewrites a report that has already gone out.
        tx.report.count({
          where: { status: "released", studyId: { in: [survivor.studyId, retired.studyId] } },
        }),
        tx.priorityScore.count({ where: { needId: survivorNeedId } }),
      ]);

      const warnings: { code: string; count?: number }[] = [];
      if (survivor.studyId !== retired.studyId) {
        // Not refused — a duplicate genuinely can be entered under two studies
        // — but it moves responses across a study boundary, which changes what
        // each study's own totals contain. The reviewer should know.
        warnings.push({ code: "DIFFERENT_STUDIES" });
      }
      const retiredScores = await tx.priorityScore.count({ where: { needId: retiredNeedId } });
      if (retiredScores > 0) {
        warnings.push({ code: "RETIRED_HAS_SCORES", count: retiredScores });
      }

      return {
        survivor: {
          id: survivor.id,
          reference: formatReference(survivor.internalRefSeq),
          title: survivor.title,
          referenceId: survivor.referenceId,
        },
        retired: {
          id: retired.id,
          reference: formatReference(retired.internalRefSeq),
          title: retired.title,
          referenceId: retired.referenceId,
        },
        transfers,
        totalTransfers,
        aliasedReference: formatReference(retired.internalRefSeq),
        externalReferences: [
          ...new Set(
            [survivor.referenceId, retired.referenceId, ...survivor.absorbedReferenceIds].filter(
              (r): r is string => Boolean(r),
            ),
          ),
        ],
        frozenReportCount,
        scoresToRecalculate,
        warnings,
      };
    });
  }

  /**
   * Merge history — Q24 asks for the merge to be recorded and reversible, and
   * a record nobody can find is not a record. Includes undone merges: "this
   * was merged and then reversed, by whom and why" is exactly the history an
   * auditor comes here for.
   */
  async list(query: { page?: number; pageSize?: number }): Promise<{
    items: MergeHistoryItem[];
    total: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const run = isCrossOrgReader()
      ? this.tenant.runAsSupervisor.bind(this.tenant)
      : this.tenant.runInOrgContext.bind(this.tenant);

    return run(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.needMerge.findMany({
          orderBy: { decidedAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.needMerge.count(),
      ]);

      const needIds = [...new Set(rows.flatMap((r) => [r.survivorNeedId, r.retiredNeedId]))];
      const userIds = [
        ...new Set(rows.flatMap((r) => [r.decidedBy, r.undoneBy]).filter((v): v is string => !!v)),
      ];
      const [needs, users] = await Promise.all([
        needIds.length
          ? tx.need.findMany({
              // Deliberately NOT filtered by EXCLUDE_MERGED: half the needs in
              // this list are retired by definition, and hiding them would
              // empty the very history this endpoint exists to show.
              where: { id: { in: needIds } },
              select: { id: true, internalRefSeq: true, title: true },
            })
          : [],
        userIds.length
          ? tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
          : [],
      ]);
      const needById = new Map(
        needs.map((n) => [
          n.id,
          { id: n.id, reference: formatReference(n.internalRefSeq), title: n.title },
        ]),
      );
      const nameById = new Map(users.map((u) => [u.id, u.name]));

      return {
        total,
        items: rows.map((row) => ({
          id: row.id,
          survivor: needById.get(row.survivorNeedId) ?? null,
          retired: needById.get(row.retiredNeedId) ?? null,
          // From the merge row, not the ledger: undo clears the ledger, and an
          // undone merge must still report what it moved.
          transferredCount: row.transferredCount,
          note: row.note,
          decidedAt: row.decidedAt,
          decidedByName: nameById.get(row.decidedBy) ?? null,
          undoneAt: row.undoneAt,
          undoneByName: row.undoneBy ? (nameById.get(row.undoneBy) ?? null) : null,
          undoNote: row.undoNote,
          canUndo: row.undoneAt === null,
        })),
      };
    });
  }

  /**
   * Perform the merge. One transaction: either everything moves and the need
   * is retired, or nothing happens.
   */
  async merge(input: {
    survivorNeedId: string;
    retiredNeedId: string;
    candidateId?: string;
    note?: string;
  }): Promise<{ mergeId: string; transferred: number }> {
    const orgId = requireOrgId();
    const actor = requireActor();

    // Q23 names System Admin as a decision owner, and a crossEntity role can
    // see these pairs — so it can merge them, in the OWNING entity's context.
    const targetOrgId = await this.resolveNeedOrg(input.survivorNeedId, orgId);

    const result = await this.tenant.runAsOrg(targetOrgId, async (tx) => {
      const { survivor, retired } = await this.loadPair(
        tx,
        input.survivorNeedId,
        input.retiredNeedId,
      );

      const merge = await tx.needMerge.create({
        data: {
          orgId,
          survivorNeedId: survivor.id,
          retiredNeedId: retired.id,
          candidateId: input.candidateId ?? null,
          note: input.note?.trim() || null,
          decidedBy: actor,
        },
        select: { id: true },
      });

      // 1. Move everything, recording where each item came from (Q50).
      let transferred = 0;
      for (const entry of TRANSFERABLE) {
        const ids = await this.idsFor(tx, entry.delegate, retired.id);
        if (ids.length === 0) continue;
        await this.reassign(tx, entry.delegate, ids, survivor.id);
        await tx.needMergeTransfer.createMany({
          data: ids.map((entityId) => ({
            mergeId: merge.id,
            orgId,
            entityType: entry.model,
            entityId,
            fromNeedId: retired.id,
            toNeedId: survivor.id,
          })),
        });
        transferred += ids.length;
      }

      // 2. The retired reference keeps resolving (Q51). Permanent — it is not
      //    removed by undo.
      await tx.needReferenceAlias.upsert({
        where: { retiredInternalRefSeq: retired.internalRefSeq },
        create: {
          orgId,
          retiredInternalRefSeq: retired.internalRefSeq,
          retiredNeedId: retired.id,
          needId: survivor.id,
          mergeId: merge.id,
        },
        update: { needId: survivor.id, mergeId: merge.id },
      });

      // 3. Both external references retained on the survivor (Q51), without
      //    overwriting the survivor's own.
      if (retired.referenceId && retired.referenceId !== survivor.referenceId) {
        const absorbed = [...new Set([...survivor.absorbedReferenceIds, retired.referenceId])];
        await tx.need.update({
          where: { id: survivor.id },
          data: { absorbedReferenceIds: absorbed },
        });
      }

      // 4. Retire the need. Never deleted — "no entry overrides another one".
      await tx.need.update({
        where: { id: retired.id },
        data: { mergedIntoNeedId: survivor.id },
      });

      // 5. Close the queue candidate, if this came from one.
      if (input.candidateId) {
        await tx.duplicateCandidate.updateMany({
          where: { id: input.candidateId, status: { in: ["pending", "confirmed_duplicate"] } },
          data: { status: "merged", reviewedBy: actor, reviewedAt: new Date() },
        });
      }

      // Recorded on the merge itself so the history keeps it after an undo
      // clears the ledger.
      await tx.needMerge.update({
        where: { id: merge.id },
        data: { transferredCount: transferred },
      });

      return { mergeId: merge.id, transferred, survivor, retired };
    });

    // Q24 — "current scores are recalculated". The survivor now carries the
    // retired need's responses and evidence, so its score is out of date the
    // moment the merge commits.
    //
    // score() APPENDS a new PriorityScore rather than replacing the old one,
    // and that is deliberate here: every reader takes the latest row
    // (`take: 1, orderBy: scoredAt desc`), so this is a score history, not the
    // duplication problem scoreResponse had. The new row is unapproved, which
    // is correct — a changed number goes through the same sign-off gate as any
    // other (RIO-FR-003).
    //
    // Best-effort and run in the OWNING entity's context: the merge is already
    // committed, and a scoring failure must not undo it. Published reports are
    // untouched either way — Q24 freezes those.
    const store = getOrgStore();
    let rescored = false;
    try {
      await orgContext.run(
        { ...(store ?? { requestId: "merge" }), orgId: targetOrgId },
        () => this.priority.score(result.survivor.id),
      );
      rescored = true;
    } catch (err) {
      this.logger.warn(
        `Re-scoring the surviving need failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.audit.record({
      action: "merge_needs",
      entityType: "need",
      entityId: result.survivor.id,
      entityLabel: `${formatReference(result.retired.internalRefSeq)} merged into ${formatReference(result.survivor.internalRefSeq)}`,
      organizationId: targetOrgId,
      changes: [
        { field: "Survivor", before: null, after: formatReference(result.survivor.internalRefSeq) },
        { field: "Retired", before: null, after: formatReference(result.retired.internalRefSeq) },
        { field: "Items transferred", before: null, after: result.transferred },
        {
          field: "Retired reference",
          before: "resolves to its own need",
          after: `alias of ${formatReference(result.survivor.internalRefSeq)}`,
        },
        // Q24, said out loud rather than left for a reader to work out.
        { field: "Published reports", before: null, after: "unchanged — frozen as historical record" },
        {
          field: "Priority scores",
          before: null,
          after: rescored
            ? "recalculated for the surviving need, awaiting approval"
            : "stale — re-scoring failed, the surviving need needs re-scoring",
        },
        { field: "Note", before: null, after: result.retired ? (input.note?.trim() ?? null) : null },
      ],
    });

    return { mergeId: result.mergeId, transferred: result.transferred };
  }

  /**
   * Reverse a merge (Q24). The note is mandatory — enforced here and by a
   * CHECK constraint, because an undo without a reason is the one thing a
   * later reader cannot reconstruct.
   *
   * The reference alias is deliberately NOT removed. A report published while
   * the needs were merged may cite the retired number; deleting the alias
   * would break that link, which is exactly what Q51 says must not happen.
   */
  async undo(mergeId: string, note: string): Promise<{ restored: number }> {
    const orgId = requireOrgId();
    const actor = requireActor();

    if (!note?.trim()) {
      throw new BadRequestException({
        error: {
          code: "NOTE_REQUIRED",
          message: "A note is required when undoing a merge.",
        },
      });
    }

    const targetOrgId = await this.resolveMergeOrg(mergeId, orgId);

    const result = await this.tenant.runAsOrg(targetOrgId, async (tx) => {
      const merge = await tx.needMerge.findUnique({
        where: { id: mergeId },
        include: { transfers: true },
      });
      if (!merge) {
        throw new NotFoundException({
          error: { code: "MERGE_NOT_FOUND", message: "Merge not found." },
        });
      }
      if (merge.undoneAt) {
        throw new BadRequestException({
          error: { code: "MERGE_ALREADY_UNDONE", message: "This merge was already undone." },
        });
      }

      // Put every transferred row back where the ledger says it came from.
      let restored = 0;
      for (const entry of TRANSFERABLE) {
        const ids = merge.transfers
          .filter((t) => t.entityType === entry.model)
          .map((t) => t.entityId);
        if (ids.length === 0) continue;
        await this.reassign(tx, entry.delegate, ids, merge.retiredNeedId);
        restored += ids.length;
      }
      await tx.needMergeTransfer.deleteMany({ where: { mergeId } });

      // Un-retire the need.
      await tx.need.update({
        where: { id: merge.retiredNeedId },
        data: { mergedIntoNeedId: null },
      });

      // Take the absorbed external reference back off the survivor.
      const retired = await tx.need.findUnique({
        where: { id: merge.retiredNeedId },
        select: { referenceId: true },
      });
      if (retired?.referenceId) {
        const survivor = await tx.need.findUnique({
          where: { id: merge.survivorNeedId },
          select: { absorbedReferenceIds: true },
        });
        if (survivor) {
          await tx.need.update({
            where: { id: merge.survivorNeedId },
            data: {
              absorbedReferenceIds: survivor.absorbedReferenceIds.filter(
                (r) => r !== retired.referenceId,
              ),
            },
          });
        }
      }

      // Reopen the candidate so the pair returns to the queue rather than
      // silently disappearing from it.
      if (merge.candidateId) {
        await tx.duplicateCandidate.updateMany({
          where: { id: merge.candidateId, status: "merged" },
          data: { status: "confirmed_duplicate" },
        });
      }

      await tx.needMerge.update({
        where: { id: mergeId },
        data: { undoneBy: actor, undoneAt: new Date(), undoNote: note.trim() },
      });

      return { restored, merge };
    });

    await this.audit.record({
      action: "undo_need_merge",
      entityType: "need",
      entityId: result.merge.survivorNeedId,
      entityLabel: "Merge undone",
      organizationId: targetOrgId,
      changes: [
        { field: "Items restored", before: null, after: result.restored },
        {
          field: "Retired reference alias",
          before: null,
          after: "kept — a report published while merged may still cite it",
        },
        { field: "Priority scores", before: null, after: "stale — both needs need re-scoring" },
        { field: "Note", before: null, after: note.trim() },
      ],
    });

    return { restored: result.restored };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Which entity owns this need — see FlagReviewService.resolveFlagOrg. */
  private async resolveNeedOrg(needId: string, actorOrgId: string): Promise<string> {
    if (!isCrossOrgReader()) return actorOrgId;
    const row = await this.tenant.runAsSupervisor((tx) =>
      tx.need.findUnique({ where: { id: needId }, select: { orgId: true } }),
    );
    return row?.orgId ?? actorOrgId;
  }

  private async resolveMergeOrg(mergeId: string, actorOrgId: string): Promise<string> {
    if (!isCrossOrgReader()) return actorOrgId;
    const row = await this.tenant.runAsSupervisor((tx) =>
      tx.needMerge.findUnique({ where: { id: mergeId }, select: { orgId: true } }),
    );
    return row?.orgId ?? actorOrgId;
  }

  private async loadPair(
    tx: Prisma.TransactionClient,
    survivorNeedId: string,
    retiredNeedId: string,
  ) {
    if (survivorNeedId === retiredNeedId) {
      throw new BadRequestException({
        error: { code: "SAME_NEED", message: "A need cannot be merged into itself." },
      });
    }
    const select = {
      id: true,
      orgId: true,
      studyId: true,
      internalRefSeq: true,
      title: true,
      referenceId: true,
      absorbedReferenceIds: true,
      mergedIntoNeedId: true,
    } as const;

    const [survivor, retired] = await Promise.all([
      tx.need.findUnique({ where: { id: survivorNeedId }, select }),
      tx.need.findUnique({ where: { id: retiredNeedId }, select }),
    ]);
    if (!survivor || !retired) {
      throw new NotFoundException({
        error: { code: "NEED_NOT_FOUND", message: "One of these needs no longer exists." },
      });
    }
    // No chains. Merging into an already-retired need would leave rows on a
    // need that is itself hidden from every list, which is how data goes
    // quietly missing.
    if (survivor.mergedIntoNeedId) {
      throw new BadRequestException({
        error: {
          code: "SURVIVOR_ALREADY_MERGED",
          message: "The surviving need has itself been merged into another. Merge into that one instead.",
        },
      });
    }
    if (retired.mergedIntoNeedId) {
      throw new BadRequestException({
        error: { code: "ALREADY_MERGED", message: "This need has already been merged." },
      });
    }
    // Cross-entity merging is not in scope: Q9 confines cross-entity
    // visibility to the Center/NCNP role, and merging two entities' needs
    // would move one entity's data into another's, which nothing in the
    // client's answers authorises.
    if (survivor.orgId !== retired.orgId) {
      throw new BadRequestException({
        error: {
          code: "CROSS_ORG_MERGE",
          message: "Needs belonging to different entities cannot be merged.",
        },
      });
    }
    return { survivor, retired };
  }

  /** Typed-enough dynamic delegate access — every entry has needId. */
  private delegate(
    tx: Prisma.TransactionClient,
    name: string,
  ): {
    count: (args: unknown) => Promise<number>;
    findMany: (args: unknown) => Promise<{ id: string }[]>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  } {
    const delegate = (
      tx as unknown as Record<
        string,
        | {
            count: (args: unknown) => Promise<number>;
            findMany: (args: unknown) => Promise<{ id: string }[]>;
            updateMany: (args: unknown) => Promise<{ count: number }>;
          }
        | undefined
      >
    )[name];
    if (!delegate) {
      // TRANSFERABLE names are Prisma delegates; a typo here would silently
      // skip a whole class of rows during a merge, which is precisely the
      // "nothing is lost" guarantee Q50 asks for.
      throw new Error(`Unknown Prisma delegate "${name}" in the merge transfer set.`);
    }
    return delegate;
  }

  private countFor(
    tx: Prisma.TransactionClient,
    name: string,
    needId: string,
  ): Promise<number> {
    return this.delegate(tx, name).count({ where: { needId } });
  }

  private async idsFor(
    tx: Prisma.TransactionClient,
    name: string,
    needId: string,
  ): Promise<string[]> {
    const rows = await this.delegate(tx, name).findMany({
      where: { needId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  private async reassign(
    tx: Prisma.TransactionClient,
    name: string,
    ids: string[],
    toNeedId: string,
  ): Promise<void> {
    await this.delegate(tx, name).updateMany({
      where: { id: { in: ids } },
      data: { needId: toNeedId },
    });
  }
}
