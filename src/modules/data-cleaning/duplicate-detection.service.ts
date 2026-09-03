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
}
