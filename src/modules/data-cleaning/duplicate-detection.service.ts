import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "../../generated/prisma";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { CleaningContextService } from "./cleaning-context.service";

/**
 * RIO-FR-002 — the LITERAL duplicate pass.
 *
 * Two needs are proposed as possible duplicates when their folded title or
 * statement is similar enough, or when they carry the same submitter reference
 * id. That is all this does: it PROPOSES (Q11). No code path here merges,
 * edits or hides a Need, and the schema is what makes that true — writing a
 * duplicate_candidates row cannot change a need.
 *
 * RIO-AI-004 adds a second pass over the same table with method = "semantic",
 * and the merge action. Q40 has both feeding ONE reviewer queue, which is why
 * `method` was on this table from its first migration rather than being added
 * later.
 *
 * ─── Why the comparison runs in Postgres ────────────────────────────────────
 * The candidate query uses pg_trgm's `%` operator over rio_fold_text(title)
 * and rio_fold_text(statement), which is what the two functional GIN indexes
 * created with this feature exist to serve. Pulling every need in the org into
 * Node and comparing there would be O(n) per save and could never use them.
 *
 * A caveat, measured rather than assumed: at pilot scale the planner does NOT
 * pick the trigram index for `needs`. RLS puts an org_id predicate on every
 * query, and against ~100 rows the org_id index plus a filter is genuinely
 * cheaper — EXPLAIN confirms it chooses that, and chooses the trigram index on
 * `centers` (1,404 rows, no RLS). The indexes are here for the shape of the
 * query and for the row counts this table will actually reach; they are not
 * doing the work today, and a performance claim about them would be false.
 *
 * `%` uses pg_trgm's own similarity floor (0.3 by default) purely as a cheap
 * prefilter. The real decision is the configured threshold applied below,
 * which starts conservative per Q23.
 */

// How many needs are pulled from the database at a time. The pass itself has
// no ceiling — this only bounds memory, not coverage.
const CROSS_ORG_BATCH = 500;

// Partners considered per need. The query returns them best-first, so a need
// with more near-matches than this keeps the strongest — and at this width a
// genuine duplicate being pushed out would mean 50 better matches exist, which
// is a data problem, not a detection one.
const CROSS_ORG_PARTNERS_PER_NEED = 50;

interface CrossOrgSeed {
  id: string;
  orgId: string;
  title: string;
  statement: string;
  referenceId: string | null;
  internalRefSeq: number;
}

interface CandidateRow {
  id: string;
  org_id: string;
  study_id: string;
  score: number;
  same_reference: boolean;
}

@Injectable()
export class DuplicateDetectionService {
  private readonly logger = new Logger(DuplicateDetectionService.name);
  private readonly detectorVersion = "literal-v1";

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly context: CleaningContextService,
  ) {}

  /**
   * Look for duplicates of one Need. Never throws — called fire-and-forget
   * from the same adapters as cleaning, after the Need is already saved.
   */
  async detectForNeed(needId: string, orgId: string): Promise<number> {
    try {
      const { settings } = await this.context.load();
      const scopes = settings.duplicateScopes;
      const threshold = settings.literalDuplicateThreshold;

      return await this.tenant.runAsOrg(orgId, async (tx) => {
        const need = await tx.need.findUnique({
          where: { id: needId },
          select: { id: true, studyId: true, title: true, statement: true, referenceId: true },
        });
        if (!need) return 0;

        const rows = await this.findCandidates(tx, need, scopes.withinOrg !== false);
        let written = 0;

        for (const row of rows) {
          const score = row.same_reference ? 1 : row.score;
          if (score < threshold) continue;

          const scope = row.study_id === need.studyId ? "within_study" : "within_org";
          if (scope === "within_study" && scopes.withinStudy === false) continue;
          if (scope === "within_org" && scopes.withinOrg === false) continue;

          // The pair is stored ORDERED (need_a_id < need_b_id, enforced by a
          // CHECK), so (A,B) and (B,A) can never both sit in the queue and the
          // unique index on (a, b, method) is sufficient on its own.
          const [aId, bId] = needId < row.id ? [needId, row.id] : [row.id, needId];
          const [aOrg, bOrg] = needId < row.id ? [orgId, row.org_id] : [row.org_id, orgId];

          const existing = await tx.duplicateCandidate.findUnique({
            where: {
              needAId_needBId_method: { needAId: aId, needBId: bId, method: "literal" },
            },
            select: { id: true, status: true },
          });

          if (existing) {
            // A reviewer's decision is never revisited by a later scan. Only
            // an undecided candidate has its score refreshed.
            if (existing.status !== "pending") continue;
            await tx.duplicateCandidate.update({
              where: { id: existing.id },
              data: { score, threshold, detectorVersion: this.detectorVersion },
            });
            continue;
          }

          await tx.duplicateCandidate.create({
            data: {
              orgId,
              needAId: aId,
              needBId: bId,
              needAOrgId: aOrg,
              needBOrgId: bOrg,
              scope,
              method: "literal",
              score,
              threshold,
              detectorVersion: this.detectorVersion,
            },
          });
          written++;
        }
        return written;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Duplicate detection skipped for need ${needId}: ${message}`);
      return 0;
    }
  }

  /**
   * Candidate retrieval, indexed.
   *
   * `%` is pg_trgm's "similar enough to be worth scoring" operator and is what
   * lets the GIN indexes do the work; the expressions must match the indexed
   * ones exactly (rio_fold_text("title"), rio_fold_text("statement")) or
   * Postgres falls back to a sequential scan.
   *
   * A shared referenceId is treated as a match on its own, regardless of
   * wording: two rows carrying the same submitter reference are the same
   * submission by definition, and their text may legitimately differ.
   *
   * RLS scopes this to the caller's org, so cross-entity comparison cannot
   * happen here even by accident — that is AI-004's, and Q9 confines it to the
   * Center/NCNP role.
   */
  private async findCandidates(
    tx: Prisma.TransactionClient,
    need: { id: string; studyId: string; title: string; statement: string; referenceId: string | null },
    acrossStudies: boolean,
  ): Promise<CandidateRow[]> {
    const studyFilter = acrossStudies
      ? Prisma.sql``
      : Prisma.sql`AND n.study_id = ${need.studyId}::uuid`;
    const reference = need.referenceId?.trim() || null;

    return tx.$queryRaw<CandidateRow[]>`
      SELECT
        n.id,
        n.org_id,
        n.study_id,
        GREATEST(
          similarity(rio_fold_text(n.title), rio_fold_text(${need.title})),
          similarity(rio_fold_text(n.statement), rio_fold_text(${need.statement}))
        ) AS score,
        (${reference}::text IS NOT NULL AND n.reference_id = ${reference}::text) AS same_reference
      FROM needs n
      WHERE n.id <> ${need.id}::uuid
        -- A retired need must never be proposed again (RIO-AI-004). It is not
        -- deleted, so it would otherwise keep surfacing as a duplicate of the
        -- need it was merged into.
        AND n.merged_into_need_id IS NULL
        ${studyFilter}
        AND (
          rio_fold_text(n.title) % rio_fold_text(${need.title})
          OR rio_fold_text(n.statement) % rio_fold_text(${need.statement})
          OR (${reference}::text IS NOT NULL AND n.reference_id = ${reference}::text)
        )
      ORDER BY score DESC
      LIMIT 20
    `;
  }

  /**
   * RIO-AI-004 / Q9 — the CROSS-ENTITY pass.
   *
   * The client ruled that cross-entity duplicate candidates may surface only
   * to the Center / NCNP Supervisor, because comparing across entities means
   * one entity's reviewer could otherwise see another's need text, which
   * NFR-003 forbids. That restriction is enforced in the RLS policy on
   * duplicate_candidates (cross-org rows carry org_id NULL and are reachable
   * only through the no-GUC path), and `pnpm ai004:verify-tenancy` proves it.
   *
   * ─── Why this is a deliberate batch, not part of the save path ───────────
   * The within-org passes run when a need is saved, which is cheap: the query
   * is scoped to one org. Comparing ACROSS entities means every save in any
   * entity would read every other entity's needs — expensive, and it would
   * quietly make one entity's write depend on another's data volume. It is
   * also a privacy-sensitive operation that should happen because someone
   * decided it should, not as a side effect of a researcher pressing save.
   *
   * So it is an explicit pass, off by default
   * (`duplicateScopes.crossOrg = false`), reading through the SELECT-only
   * supervisor client and writing through the no-GUC path — the two halves of
   * the boundary the policy already draws.
   */
  /**
   * RIO-AI-004 / Q9 — the cross-entity pass.
   *
   * ─── What this used to do, and why it was wrong ───────────────────────────
   * It took `limit = 200`, the controller called it with no argument, and the
   * query was `orderBy internalRefSeq asc, take: 200`. Past 200 needs it
   * compared the OLDEST 200 only and reported success. Nothing anywhere said
   * the scan had been partial — the reviewer saw "0 proposed" and reasonably
   * concluded there were no cross-entity duplicates.
   *
   * It also folded the same text inside a doubly-nested loop: 1,000 needs meant
   * 499,500 comparisons and 999,000 redundant folds, measured at 14.4s.
   *
   * ─── What it does now ─────────────────────────────────────────────────────
   * Pages through EVERY unmerged need and asks Postgres for each one's
   * cross-entity partners, using the same `%` operator and functional trigram
   * indexes the within-entity pass uses. That turns an O(n²) Node loop into n
   * index-assisted queries, and the folding happens once per row inside the
   * database rather than n times in JavaScript.
   *
   * `n.id > $id` gives each pair exactly once, which lines up with the
   * ordered-pair CHECK (need_a_id < need_b_id) rather than fighting it.
   *
   * A caller may still pass `maxNeeds` to bound a run — but the result now
   * carries `truncated`, so a partial scan can never again look like a complete
   * one that found nothing.
   */
  async runCrossOrgPass(
    options: { maxNeeds?: number } = {},
  ): Promise<{ scanned: number; proposed: number; truncated: boolean }> {
    const { settings } = await this.context.load();
    if (settings.duplicateScopes.crossOrg !== true) {
      this.logger.log(
        "Cross-entity duplicate detection is off (duplicateScopes.crossOrg). Nothing scanned.",
      );
      return { scanned: 0, proposed: 0, truncated: false };
    }
    const threshold = settings.literalDuplicateThreshold;

    let scanned = 0;
    let proposed = 0;
    let truncated = false;
    let cursor: number | null = null;

    for (;;) {
      // Read across entities with the SELECT-only client — the one path
      // allowed to see past the boundary.
      const batch: CrossOrgSeed[] = await this.tenant.runAsSupervisor((tx) =>
        tx.need.findMany({
          where: {
            mergedIntoNeedId: null,
            ...(cursor === null ? {} : { internalRefSeq: { gt: cursor } }),
          },
          select: {
            id: true,
            orgId: true,
            title: true,
            statement: true,
            referenceId: true,
            internalRefSeq: true,
          },
          orderBy: { internalRefSeq: "asc" },
          take: CROSS_ORG_BATCH,
        }),
      );
      if (batch.length === 0) break;

      for (const need of batch) {
        if (options.maxNeeds !== undefined && scanned >= options.maxNeeds) {
          truncated = true;
          break;
        }
        scanned++;
        proposed += await this.proposeCrossOrgPartners(need, threshold);
      }

      cursor = batch[batch.length - 1]!.internalRefSeq;
      if (truncated || batch.length < CROSS_ORG_BATCH) break;
    }

    this.logger.log(
      `Cross-entity duplicate pass: ${scanned} needs scanned, ${proposed} candidate(s) proposed` +
        `${truncated ? " (TRUNCATED — maxNeeds reached, the scan is incomplete)" : ""}.`,
    );
    return { scanned, proposed, truncated };
  }

  /**
   * The partners of one need in OTHER entities, shortlisted by Postgres.
   *
   * Mirrors findCandidates deliberately, including the `%` prefilter: the real
   * decision is the configured threshold applied here, and pg_trgm's own floor
   * (0.3) only narrows what the index returns. Lowering the configured
   * threshold below 0.3 therefore has no effect, which is the same caveat the
   * within-entity pass carries.
   */
  private async proposeCrossOrgPartners(
    need: CrossOrgSeed,
    threshold: number,
  ): Promise<number> {
    const reference = need.referenceId?.trim() || null;

    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.$queryRaw<CandidateRow[]>`
        SELECT
          n.id,
          n.org_id,
          n.study_id,
          GREATEST(
            similarity(rio_fold_text(n.title), rio_fold_text(${need.title})),
            similarity(rio_fold_text(n.statement), rio_fold_text(${need.statement}))
          ) AS score,
          (${reference}::text IS NOT NULL AND n.reference_id = ${reference}::text) AS same_reference
        FROM needs n
        WHERE n.id > ${need.id}::uuid
          AND n.org_id <> ${need.orgId}::uuid
          AND n.merged_into_need_id IS NULL
          AND (
            rio_fold_text(n.title) % rio_fold_text(${need.title})
            OR rio_fold_text(n.statement) % rio_fold_text(${need.statement})
            OR (${reference}::text IS NOT NULL AND n.reference_id = ${reference}::text)
          )
        ORDER BY score DESC
        LIMIT ${CROSS_ORG_PARTNERS_PER_NEED}
      `,
    );

    let written = 0;
    for (const row of rows) {
      const score = row.same_reference ? 1 : Number(row.score);
      if (score < threshold) continue;
      // `n.id > need.id` in the query already guarantees the order the
      // duplicate_candidates_ordered_pair CHECK requires.
      const ok = await this.writeCrossOrgCandidate(
        { id: need.id, orgId: need.orgId },
        { id: row.id, orgId: row.org_id },
        score,
        threshold,
      );
      if (ok) written++;
    }
    return written;
  }

  private async writeCrossOrgCandidate(
    lo: { id: string; orgId: string },
    hi: { id: string; orgId: string },
    score: number,
    threshold: number,
  ): Promise<boolean> {
    return this.tenant.runAsSupervisorWrite(async (tx) => {
      const existing = await tx.duplicateCandidate.findUnique({
        where: { needAId_needBId_method: { needAId: lo.id, needBId: hi.id, method: "literal" } },
        select: { id: true, status: true },
      });
      if (existing) {
        // A reviewer's decision is never revisited by a later scan.
        if (existing.status !== "pending") return false;
        await tx.duplicateCandidate.update({
          where: { id: existing.id },
          data: { score, threshold, detectorVersion: this.detectorVersion },
        });
        return false;
      }
      await tx.duplicateCandidate.create({
        data: {
          orgId: null,
          needAId: lo.id,
          needBId: hi.id,
          needAOrgId: lo.orgId,
          needBOrgId: hi.orgId,
          scope: "cross_org",
          method: "literal",
          score,
          threshold,
          detectorVersion: this.detectorVersion,
        },
      });
      return true;
    });
  }
}
