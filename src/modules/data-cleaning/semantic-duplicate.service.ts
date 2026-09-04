import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma";
import { requireActor, requireOrgId } from "../../tenancy/org-context";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { CleaningContextService } from "./cleaning-context.service";
import { cosineSimilarity, type EmbeddingProvider } from "./embedding-provider";
import { EMBEDDING_PROVIDER } from "./embedding-provider.token";
import { foldText } from "./normalizers";

/**
 * RIO-AI-004 — the SEMANTIC duplicate pass, and the half of AC 2 the literal
 * pass cannot satisfy.
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 * The literal pass compares letters. Measured on this database, that means it
 * scores two records of the same need at 0.708 when one is reworded
 * ("Risk of edu dropouts in academic year 2026" against "Dropout risk in the
 * 2026 academic year"), and at 0.000 when one is in Arabic and the other in
 * English — trigram sets over different scripts share nothing at all. On a
 * bilingual platform with cross-entity detection as a goal, that second number
 * is the reason this exists.
 *
 * ─── What it writes, and why that is the acceptance criterion ───────────────
 * Every semantic proposal writes an AiSuggestion row and links the candidate
 * to it. AC 2 is "AI suggestion and human decision stored": the decision half
 * was already there on duplicate_candidates, and this is the other half. The
 * suggestion records the model, the version, the score and a stated reason, so
 * a reviewer looking at a pair months later can see what proposed it and on
 * what basis — and so a model change is visible in the data rather than
 * inferred.
 *
 * ─── What it never does ─────────────────────────────────────────────────────
 * Propose only (Q11). Like the literal pass, it writes candidate rows and
 * nothing else. It also never revisits a pair a human has already decided.
 */

/** Cost control: a scan embeds at most this many needs that lack a vector. */
const MAX_EMBEDDINGS_PER_RUN = 200;

@Injectable()
export class SemanticDuplicateService {
  private readonly logger = new Logger(SemanticDuplicateService.name);
  private readonly detectorVersion = "semantic-v1";

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly context: CleaningContextService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  /**
   * Embed what needs embedding, then propose pairs above the threshold.
   *
   * Returns counts rather than throwing on a disabled provider: "not turned
   * on" is a normal state (see SEMANTIC_DUPLICATES_ENABLED), and the caller
   * shows the reviewer a number, not a stack trace.
   */
  async runSemanticPass(): Promise<{
    embedded: number;
    compared: number;
    proposed: number;
    skippedReason: string | null;
  }> {
    if (!this.embeddings.enabled) {
      return {
        embedded: 0,
        compared: 0,
        proposed: 0,
        skippedReason: "SEMANTIC_PROVIDER_DISABLED",
      };
    }

    const orgId = requireOrgId();
    const actor = requireActor();
    const { settings } = await this.context.load();
    const threshold = settings.semanticDuplicateThreshold;

    const embedded = await this.refreshEmbeddings(orgId);
    const { compared, proposed } = await this.proposePairs(orgId, actor, threshold);

    // Nothing to compare is not the same as nothing found, and the difference
    // matters: a platform-wide role signed in to an entity that holds no needs
    // gets zeros for a reason that has nothing to do with the scan. Saying so
    // costs one field and saves the reviewer guessing.
    if (compared === 0) {
      return {
        embedded,
        compared,
        proposed,
        skippedReason: embedded === 0 ? "NO_NEEDS_IN_SCOPE" : "NOT_ENOUGH_NEEDS_TO_COMPARE",
      };
    }

    this.logger.log(
      `Semantic pass: ${embedded} embedded, ${compared} pairs compared, ${proposed} proposed at >= ${threshold}.`,
    );
    return { embedded, compared, proposed, skippedReason: null };
  }

  /**
   * Give every need a current vector.
   *
   * "Current" is decided by a hash of the folded title+statement, so editing a
   * need regenerates its vector and editing anything else does not. That is
   * the per-edit cost Q48 flagged, kept to the minimum: no hash change, no API
   * call.
   */
  private async refreshEmbeddings(orgId: string): Promise<number> {
    const rows = await this.tenant.runAsOrg(orgId, (tx) =>
      tx.need.findMany({
        where: { mergedIntoNeedId: null },
        select: { id: true, title: true, statement: true },
        orderBy: { internalRefSeq: "asc" },
      }),
    );

    const wanted = rows.map((need) => ({
      ...need,
      text: this.embeddingText(need.title, need.statement),
    }));
    const hashes = new Map(wanted.map((n) => [n.id, this.hash(n.text)]));

    const existing = await this.tenant.runAsOrg(orgId, (tx) =>
      tx.needEmbedding.findMany({
        where: {
          needId: { in: wanted.map((n) => n.id) },
          embeddingVersion: this.embeddings.embeddingVersion,
        },
        select: { needId: true, textHash: true },
      }),
    );
    const current = new Map(existing.map((e) => [e.needId, e.textHash]));

    const stale = wanted
      .filter((n) => current.get(n.id) !== hashes.get(n.id))
      .slice(0, MAX_EMBEDDINGS_PER_RUN);
    if (stale.length === 0) return 0;

    const vectors = await this.embeddings.embed(stale.map((n) => n.text));
    // The provider returns [] on any failure rather than throwing, and refuses
    // to return a misaligned batch — so this is "the call did not succeed",
    // not "some needs silently got the wrong vector".
    if (vectors.length !== stale.length) return 0;

    await this.tenant.runAsOrg(orgId, async (tx) => {
      for (let i = 0; i < stale.length; i++) {
        const need = stale[i]!;
        await tx.needEmbedding.upsert({
          where: {
            needId_embeddingVersion: {
              needId: need.id,
              embeddingVersion: this.embeddings.embeddingVersion,
            },
          },
          create: {
            orgId,
            needId: need.id,
            textHash: hashes.get(need.id)!,
            modelName: this.embeddings.modelName,
            embeddingVersion: this.embeddings.embeddingVersion,
            dimensions: this.embeddings.dimensions,
            vector: vectors[i]! as unknown as Prisma.InputJsonValue,
          },
          update: {
            textHash: hashes.get(need.id)!,
            modelName: this.embeddings.modelName,
            dimensions: this.embeddings.dimensions,
            vector: vectors[i]! as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });
    return stale.length;
  }

  private async proposePairs(
    orgId: string,
    actor: string,
    threshold: number,
  ): Promise<{ compared: number; proposed: number }> {
    const vectors = await this.tenant.runAsOrg(orgId, (tx) =>
      tx.needEmbedding.findMany({
        where: { embeddingVersion: this.embeddings.embeddingVersion },
        select: { needId: true, vector: true, need: { select: { studyId: true, mergedIntoNeedId: true } } },
      }),
    );
    const live = vectors
      .filter((v) => v.need.mergedIntoNeedId === null)
      .map((v) => ({
        needId: v.needId,
        studyId: v.need.studyId,
        vector: v.vector as unknown as number[],
      }));

    let compared = 0;
    let proposed = 0;
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;
        compared++;
        const score = cosineSimilarity(a.vector, b.vector);
        if (score < threshold) continue;
        if (await this.writeCandidate(orgId, actor, a, b, score, threshold)) proposed++;
      }
    }
    return { compared, proposed };
  }

  /** One AiSuggestion + one candidate, or nothing. Never revisits a decision. */
  private async writeCandidate(
    orgId: string,
    actor: string,
    first: { needId: string; studyId: string },
    second: { needId: string; studyId: string },
    score: number,
    threshold: number,
  ): Promise<boolean> {
    const [lo, hi] = first.needId < second.needId ? [first, second] : [second, first];

    return this.tenant.runAsOrg(orgId, async (tx) => {
      const existing = await tx.duplicateCandidate.findUnique({
        where: {
          needAId_needBId_method: { needAId: lo.needId, needBId: hi.needId, method: "semantic" },
        },
        select: { id: true, status: true },
      });
      if (existing) {
        // A reviewer's decision is final for this pair and this method. Only a
        // still-pending proposal gets its score refreshed.
        if (existing.status !== "pending") return false;
        await tx.duplicateCandidate.update({
          where: { id: existing.id },
          data: { score, threshold, detectorVersion: this.detectorVersion },
        });
        return false;
      }

      // AC 2's "AI suggestion stored". Written first so the candidate can
      // point at it, and carrying everything needed to explain the proposal
      // later: which model, which version, how confident, and why.
      const suggestion = await tx.aiSuggestion.create({
        data: {
          orgId,
          needId: lo.needId,
          studyId: lo.studyId,
          type: "duplicate_detection",
          confidence: score,
          reason:
            `Meaning-based match: these two needs read as the same need at ` +
            `${(score * 100).toFixed(1)}% similarity, at or above the ${(threshold * 100).toFixed(0)}% ` +
            `threshold. Proposed for review, not merged.`,
          modelName: this.embeddings.modelName,
          promptVersion: this.embeddings.embeddingVersion,
          createdBy: actor,
        },
        select: { id: true },
      });

      await tx.duplicateCandidate.create({
        data: {
          orgId,
          needAId: lo.needId,
          needBId: hi.needId,
          needAOrgId: orgId,
          needBOrgId: orgId,
          scope: lo.studyId === hi.studyId ? "within_study" : "within_org",
          method: "semantic",
          score,
          threshold,
          detectorVersion: this.detectorVersion,
          aiSuggestionId: suggestion.id,
        },
      });
      return true;
    });
  }

  /**
   * Title and statement together, folded.
   *
   * Folded rather than raw so the hash does not churn on punctuation or casing
   * changes that cannot alter meaning — an edit that only re-spaces a title
   * should not cost an API call.
   */
  private embeddingText(title: string, statement: string): string {
    return foldText(`${title}\n${statement}`);
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }
}
