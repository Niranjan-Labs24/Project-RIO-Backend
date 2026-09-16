import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma';
import { requireActor, requireOrgId } from '../../tenancy/org-context';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { CleaningContextService } from './cleaning-context.service';
import { cosineSimilarity, type EmbeddingProvider } from './embedding-provider';
import { EMBEDDING_PROVIDER } from './embedding-provider.token';
import { foldText, trigramSimilarity } from './normalizers';

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

/** What the gates need to see about one side of a pair. */
export interface PairCandidate {
  needId: string;
  studyId: string;
  domain: string | null;
  subDomain: string | null;
  text: string;
  vector: number[];
}

/**
 * A four-digit year stated anywhere in the text, e.g. "academic year 2026".
 *
 * Bounded to 2000-2099 on purpose: a bare "1200" is far more likely to be a
 * population figure, a distance or a budget than a year, and treating it as one
 * would block genuine duplicates.
 */
export function statedYears(text: string): Set<string> {
  return new Set(text.match(/\b20\d{2}\b/g) ?? []);
}

/**
 * The cheap, AI-free filter that runs before any vector is compared.
 *
 * Two gates, both of which exist because of a false positive that was MEASURED
 * rather than imagined:
 *
 *   Domain — "Education gap" and "Water supply on school" scored **0.818**
 *   against each other. Embeddings of community needs sit in a narrow band
 *   (unrelated pairs measured 0.678-0.886) because every one of them is a
 *   community need, so raising the threshold to exclude that pair would also
 *   exclude real duplicates at 0.923. A domain check removes the whole
 *   category for free, and does what no threshold can.
 *
 *   Period — the same need stated for two different years scored **0.983**,
 *   ABOVE most genuine duplicates. No threshold separates it, in either
 *   direction. If both texts name a year and the years are disjoint, they are
 *   about different periods and are not the same need.
 *
 * Both gates fail OPEN when the information is absent: an unclassified need is
 * compared against everything, and a need with no stated year is never blocked
 * by the period gate. A missing field is not evidence of difference, and
 * refusing to compare on that basis would hide duplicates rather than prevent
 * false ones.
 */
export function periodsCompatible(textA: string, textB: string): boolean {
  const yearsA = statedYears(textA);
  const yearsB = statedYears(textB);
  if (yearsA.size === 0 || yearsB.size === 0) return true;
  return [...yearsA].some((y) => yearsB.has(y));
}

export function gatePair(
  a: PairCandidate,
  b: PairCandidate,
): { ok: true } | { ok: false; reason: string } {
  if (a.domain && b.domain && a.domain !== b.domain) {
    return { ok: false, reason: 'DIFFERENT_DOMAIN' };
  }
  // Sub-domain only when the domains agree — otherwise it is already blocked.
  if (a.subDomain && b.subDomain && a.subDomain !== b.subDomain) {
    return { ok: false, reason: 'DIFFERENT_SUB_DOMAIN' };
  }

  // One implementation, shared with the indexed path. Two copies of this rule
  // would be the rio_fold_text problem again.
  if (!periodsCompatible(a.text, b.text)) {
    return { ok: false, reason: 'DIFFERENT_PERIOD' };
  }

  return { ok: true };
}

/**
 * Neighbours considered per need on the indexed path.
 *
 * Returned best-first, so a need with more near-matches than this keeps the
 * strongest. At this width a genuine duplicate being pushed out would mean 50
 * closer matches exist, which is a data problem rather than a detection one.
 * Matches the literal pass's own per-need width for the same reason.
 */
const NEIGHBOURS_PER_NEED = 50;

interface SeedRow {
  need_id: string;
  study_id: string;
  title: string;
  statement: string;
  vector_text: string;
}

interface NeighbourRow {
  need_id: string;
  study_id: string;
  title: string;
  statement: string;
  score: number;
}

/** Cost control: a scan embeds at most this many needs that lack a vector. */
const MAX_EMBEDDINGS_PER_RUN = 200;

@Injectable()
export class SemanticDuplicateService {
  private readonly logger = new Logger(SemanticDuplicateService.name);
  private readonly detectorVersion = 'semantic-v1';
  /** Resolved once per process by hasPgvector(). */
  private pgvectorAvailable: boolean | null = null;

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
        skippedReason: 'SEMANTIC_PROVIDER_DISABLED',
      };
    }

    const orgId = requireOrgId();
    const actor = requireActor();
    const { settings } = await this.context.load();
    const threshold = settings.semanticDuplicateThreshold;

    const embedded = await this.refreshEmbeddings(orgId);
    const { compared, proposed, blocked } = await this.proposePairs(orgId, actor, threshold);

    // Nothing to compare is not the same as nothing found, and the difference
    // matters: a platform-wide role signed in to an entity that holds no needs
    // gets zeros for a reason that has nothing to do with the scan. Saying so
    // costs one field and saves the reviewer guessing.
    if (compared === 0) {
      return {
        embedded,
        compared,
        proposed,
        skippedReason: embedded === 0 ? 'NO_NEEDS_IN_SCOPE' : 'NOT_ENOUGH_NEEDS_TO_COMPARE',
      };
    }

    this.logger.log(
      `Semantic pass: ${embedded} embedded, ${compared} pairs compared ` +
        `(${blocked} blocked by the structural gate), ${proposed} proposed at >= ${threshold}.`,
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
        orderBy: { internalRefSeq: 'asc' },
      }),
    );

    const wanted = rows.map((need) => ({
      ...need,
      text: this.embeddingText(need.title, need.statement),
    }));
    // Hashed on the FOLDED form, embedded on the raw one — see embeddingText.
    const hashes = new Map(
      rows.map((n) => [n.id, this.hash(this.freshnessKey(n.title, n.statement))]),
    );

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

    // Populate the typed column for the rows just written. Prisma has no
    // `vector` type, so this is raw — and it casts from the JSONB we already
    // stored rather than sending 768 floats a second time.
    //
    // Both columns are kept deliberately: the JSONB is what the in-memory
    // fallback reads on a server without pgvector, and dropping it would make
    // the feature unavailable there rather than merely slower.
    if (await this.hasPgvector(orgId)) {
      await this.tenant.runAsOrg(
        orgId,
        (tx) =>
          tx.$executeRaw`
          UPDATE need_embeddings
             SET embedding = vector::text::vector
           WHERE embedding_version = ${this.embeddings.embeddingVersion}
             AND embedding IS NULL
             AND jsonb_array_length(vector) = ${this.embeddings.dimensions}
        `,
      );
    }

    return stale.length;
  }

  /**
   * Compare the pairs worth comparing, and propose the ones that survive every
   * gate.
   *
   * ─── Q48's "cheap first filter", and why it is NOT the literal pass ────────
   * The client's answer to Q48 accepts meaning-based matching "with (b) as a
   * cheap first filter", where (b) is word-based comparison. Applied literally
   * that would be wrong here, and measurably so: trigram similarity between an
   * Arabic need and its English twin is **0.000**, because trigram sets over
   * different scripts share nothing. Using the literal pass as a gate would
   * exclude precisely the pairs this feature exists to find.
   *
   * So the cheap first filter is STRUCTURAL rather than textual. It costs one
   * comparison of fields already loaded, needs no AI, and it removes the
   * category of false positive the threshold cannot: two needs that read alike
   * because they are both community needs, but are plainly about different
   * things.
   *
   * Gates, in order of cost:
   *   1. domain compatibility  — free, and blocks cross-domain matches
   *   2. conflicting periods   — free, and blocks the one false positive no
   *                              threshold can remove
   *   3. cosine >= threshold   — the actual semantic judgement
   */
  private async proposePairs(
    orgId: string,
    actor: string,
    threshold: number,
  ): Promise<{ compared: number; proposed: number; blocked: number }> {
    return (await this.hasPgvector(orgId))
      ? this.proposePairsIndexed(orgId, actor, threshold)
      : this.proposePairsInMemory(orgId, actor, threshold);
  }

  /**
   * Is pgvector installed on THIS server?
   *
   * Cached for the life of the process: an extension does not appear or vanish
   * between two scans, and the alternative is a catalogue query per run.
   *
   * The answer genuinely differs by environment. The team's own Windows
   * PostgreSQL 18 reports `extension "vector" is not available` — the binaries
   * are not compiled in — while a container or a managed instance with it
   * enabled takes the indexed path. Both must work, so both are implemented.
   *
   * ─── Why the WIDTH is checked too, not just presence ──────────────────────
   * A vector column is typed by dimension, and the provider's width is
   * configuration (OCI_GENAI_EMBED_DIMENSIONS) while the column's is whatever
   * the last migration declared. They can disagree — a deployment that swaps
   * AI_PROVIDER back to Gemini's 768 against a vector(1024) column is the
   * obvious case, and a re-ruling on Q10 is the next one.
   *
   * Disagreement is NOT an error. It means this server cannot use the index
   * for these vectors, which is exactly the situation the JSONB fallback
   * already exists for. Treating it as absence keeps detection working and
   * merely slower, where the alternative is refreshEmbeddings' populate step
   * raising "expected N dimensions" on every scan and the reviewer getting a
   * failed run instead of an unindexed one.
   */
  private async hasPgvector(orgId: string): Promise<boolean> {
    if (this.pgvectorAvailable !== null) return this.pgvectorAvailable;
    try {
      // atttypmod carries the declared dimension for a pgvector column, so
      // one catalogue query answers both questions. NULL when the column is
      // absent, which reads as "not available" below without a second case.
      const rows = await this.tenant.runAsOrg(
        orgId,
        (tx) =>
          tx.$queryRaw<{ installed: boolean; column_dimensions: number | null }[]>`
          SELECT
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed,
            (SELECT a.atttypmod
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relname = 'need_embeddings'
                AND a.attname = 'embedding'
                AND a.attnum > 0
                AND NOT a.attisdropped) AS column_dimensions
        `,
      );
      const installed = rows[0]?.installed === true;
      const columnDimensions = rows[0]?.column_dimensions ?? null;
      this.pgvectorAvailable = installed && columnDimensions === this.embeddings.dimensions;

      if (installed && columnDimensions !== null && !this.pgvectorAvailable) {
        // Distinct from "not installed", because the fix is different: this
        // one is a migration, not an extension.
        this.logger.warn(
          `need_embeddings.embedding is vector(${columnDimensions}) but ` +
            `${this.embeddings.modelName} returns ${this.embeddings.dimensions}. ` +
            `Comparing in the application. Migrate the column to ` +
            `${this.embeddings.dimensions} to restore the indexed path.`,
        );
      }
    } catch {
      // A catalogue query that fails is not a reason to fail the scan.
      this.pgvectorAvailable = false;
    }
    this.logger.log(
      this.pgvectorAvailable
        ? 'pgvector present: comparing in Postgres against the HNSW index.'
        : 'pgvector absent: comparing in the application. Install it to move this into the database.',
    );
    return this.pgvectorAvailable;
  }

  /**
   * The indexed path: one nearest-neighbour query per need.
   *
   * Per-need KNN rather than one giant self-join, because only KNN uses the
   * index. `ORDER BY embedding <=> $vector LIMIT k` is what an HNSW index
   * answers; a pairwise self-join over the whole table is a sequential scan
   * however it is written, and would have moved the O(n²) into Postgres rather
   * than removing it.
   *
   * `b.need_id > a.need_id` yields each pair exactly once and lines up with the
   * ordered-pair CHECK on duplicate_candidates rather than fighting it.
   *
   * ─── Which gates run WHERE, and why they are split ─────────────────────────
   * The domain and sub-domain gates run in SQL: they are equality on a column,
   * there is no second implementation to drift from, and pushing them down
   * shrinks the candidate set before the index is consulted.
   *
   * The PERIOD gate stays in TypeScript. It is a regular expression over free
   * text, and a second copy of it in SQL would be a `rio_fold_text` situation
   * all over again — two implementations of one rule that must agree forever,
   * with silent wrong answers when they stop. There are at most `k` rows to
   * filter by then, so the cost of doing it in the application is nil.
   */
  private async proposePairsIndexed(
    orgId: string,
    actor: string,
    threshold: number,
  ): Promise<{ compared: number; proposed: number; blocked: number }> {
    const seeds = await this.tenant.runAsOrg(
      orgId,
      (tx) =>
        tx.$queryRaw<SeedRow[]>`
        SELECT e.need_id, n.study_id, n.title, n.statement, e.vector::text AS vector_text
          FROM need_embeddings e
          JOIN needs n ON n.id = e.need_id
         WHERE e.embedding_version = ${this.embeddings.embeddingVersion}
           AND e.embedding IS NOT NULL
           AND n.merged_into_need_id IS NULL
         ORDER BY n.internal_ref_seq ASC
      `,
    );

    let compared = 0;
    let proposed = 0;
    let blocked = 0;

    for (const seed of seeds) {
      const neighbours = await this.tenant.runAsOrg(
        orgId,
        (tx) =>
          tx.$queryRaw<NeighbourRow[]>`
          SELECT b.need_id, nb.study_id, nb.title, nb.statement,
                 1 - (b.embedding <=> ${seed.vector_text}::vector) AS score
            FROM need_embeddings b
            JOIN needs nb ON nb.id = b.need_id
            JOIN needs na ON na.id = ${seed.need_id}::uuid
           WHERE b.embedding_version = ${this.embeddings.embeddingVersion}
             AND b.embedding IS NOT NULL
             AND b.need_id > ${seed.need_id}::uuid
             AND nb.merged_into_need_id IS NULL
             -- Gate 1, pushed down. NULL fails OPEN on either side: a missing
             -- domain is not evidence of difference.
             AND (na.domain IS NULL OR nb.domain IS NULL OR na.domain = nb.domain)
             AND (na.sub_domain IS NULL OR nb.sub_domain IS NULL OR na.sub_domain = nb.sub_domain)
           ORDER BY b.embedding <=> ${seed.vector_text}::vector
           LIMIT ${NEIGHBOURS_PER_NEED}
        `,
      );

      for (const row of neighbours) {
        const score = Number(row.score);
        if (score < threshold) break; // ordered by distance: the rest are worse

        // Gate 2 stays here — see the note above on why it is not in SQL.
        const seedText = `${seed.title} ${seed.statement}`;
        const rowText = `${row.title} ${row.statement}`;
        if (!periodsCompatible(seedText, rowText)) {
          blocked++;
          continue;
        }

        compared++;
        const literal = trigramSimilarity(foldText(seedText), foldText(rowText));
        const ok = await this.writeCandidate(
          orgId,
          actor,
          { needId: seed.need_id, studyId: seed.study_id },
          { needId: row.need_id, studyId: row.study_id },
          score,
          threshold,
          literal,
        );
        if (ok) proposed++;
      }
    }

    return { compared, proposed, blocked };
  }

  /** The fallback: every vector into memory, every pair compared here. */
  private async proposePairsInMemory(
    orgId: string,
    actor: string,
    threshold: number,
  ): Promise<{ compared: number; proposed: number; blocked: number }> {
    const vectors = await this.tenant.runAsOrg(orgId, (tx) =>
      tx.needEmbedding.findMany({
        where: { embeddingVersion: this.embeddings.embeddingVersion },
        select: {
          needId: true,
          vector: true,
          need: {
            select: {
              studyId: true,
              mergedIntoNeedId: true,
              // Loaded for the gates below. Free: the join is already happening.
              domain: true,
              subDomain: true,
              title: true,
              statement: true,
            },
          },
        },
      }),
    );
    const live: PairCandidate[] = vectors
      .filter((v) => v.need.mergedIntoNeedId === null)
      .map((v) => ({
        needId: v.needId,
        studyId: v.need.studyId,
        domain: v.need.domain,
        subDomain: v.need.subDomain,
        text: `${v.need.title} ${v.need.statement}`,
        vector: v.vector as unknown as number[],
      }));

    let compared = 0;
    let proposed = 0;
    let blocked = 0;

    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i]!;
        const b = live[j]!;

        const gate = gatePair(a, b);
        if (!gate.ok) {
          blocked++;
          continue;
        }

        compared++;
        const score = cosineSimilarity(a.vector, b.vector);
        if (score < threshold) continue;

        // The literal score is carried alongside, not used as a gate. Where the
        // two measures AGREE the pair is near-certain; where they disagree the
        // reviewer is looking at a rewording or a translation, which is the
        // interesting case. Recording both lets a reviewer tell them apart.
        const literal = trigramSimilarity(foldText(a.text), foldText(b.text));

        if (await this.writeCandidate(orgId, actor, a, b, score, threshold, literal)) {
          proposed++;
        }
      }
    }
    return { compared, proposed, blocked };
  }

  /** One AiSuggestion + one candidate, or nothing. Never revisits a decision. */
  private async writeCandidate(
    orgId: string,
    actor: string,
    first: { needId: string; studyId: string },
    second: { needId: string; studyId: string },
    score: number,
    threshold: number,
    literalScore: number,
  ): Promise<boolean> {
    const [lo, hi] = first.needId < second.needId ? [first, second] : [second, first];

    return this.tenant.runAsOrg(orgId, async (tx) => {
      const existing = await tx.duplicateCandidate.findUnique({
        where: {
          needAId_needBId_method: { needAId: lo.needId, needBId: hi.needId, method: 'semantic' },
        },
        select: { id: true, status: true },
      });
      if (existing) {
        // A reviewer's decision is final for this pair and this method. Only a
        // still-pending proposal gets its score refreshed.
        if (existing.status !== 'pending') return false;
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
          type: 'duplicate_detection',
          confidence: score,
          // Both signals, and what their disagreement means. A reviewer
          // reading this months later should be able to tell a reworded
          // duplicate from a translated one without re-running anything.
          reason:
            `Meaning-based match at ${(score * 100).toFixed(1)}% ` +
            `(threshold ${(threshold * 100).toFixed(0)}%). ` +
            `Word-based similarity is ${(literalScore * 100).toFixed(1)}%` +
            (literalScore < 0.3
              ? ` \u2014 the wording differs almost entirely, so this is a rewording or a translation the literal pass cannot see.`
              : literalScore >= threshold
                ? ` \u2014 both measures agree, so this pair is near-certain.`
                : `.`) +
            ` Same domain and no conflicting period. Proposed for review, not merged.`,
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
          scope: lo.studyId === hi.studyId ? 'within_study' : 'within_org',
          method: 'semantic',
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
   * What gets SENT to the model: the raw title and statement.
   *
   * Deliberately not folded. Folding exists to make two strings comparable as
   * character sequences — it lowercases, strips punctuation and flattens
   * diacritics. A language model uses every one of those: sentence boundaries,
   * capitalised place names, the difference between a question and a statement.
   * Feeding it the comparison key throws away signal the model was trained on.
   *
   * The FOLDED form is still what the freshness hash is computed over (see
   * `hash` callers), so re-spacing a title costs no API call while a real
   * wording change does.
   */
  private embeddingText(title: string, statement: string): string {
    return `${title}\n${statement}`.trim();
  }

  /** The comparison key, used only to decide whether a vector is stale. */
  private freshnessKey(title: string, statement: string): string {
    return foldText(`${title}\n${statement}`);
  }

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }
}
