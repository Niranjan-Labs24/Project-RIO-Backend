import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../src/generated/prisma";
import { applyRescoredPairs } from "../src/modules/data-cleaning/duplicate-detection.service";

/**
 * UAT DQ-06 / DQ-10 — one-off clean-up of the duplicate queue after literal-v2.
 *
 * ─── Why ────────────────────────────────────────────────────────────────────
 * Until literal-v2, a shared submitter reference made two needs a 100%
 * "lexical" duplicate on its own. Imports stamp one placeholder reference on
 * every row ("REF-SA-001"), so the queue filled with pairs of unrelated needs,
 * and across entities a coincidence in two entities' numbering did the same.
 * The detector no longer does this, and it reconciles a need's pending pairs
 * whenever that need is saved — but pairs created before the fix sit in the
 * queue until then. This applies the SAME rule to all of them now:
 *
 *   * within an entity: score = 1 if the two needs share a DISTINCTIVE
 *     reference (held by at most 2 live needs of that entity), otherwise the
 *     text similarity of title/statement;
 *   * across entities: text similarity only;
 *   * a pending pair whose new score is below the threshold it was proposed
 *     under is dismissed, with a note saying why. Decided pairs are untouched.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *   pnpm tsx scripts/rescore-literal-duplicates.ts                 # dry run, read-only
 *   pnpm tsx scripts/rescore-literal-duplicates.ts --apply --reviewer=sysadmin@platform.local
 *
 * A dismissal is a decision, and a CHECK requires it to name a reviewer: the
 * person running this with --apply is the one applying the rule, so they are
 * named. Idempotent: a second run finds nothing to dismiss.
 */

const supervisor = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.SUPERVISOR_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});
const app = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

const APPLY = process.argv.includes("--apply");
const REVIEWER = process.argv.find((a) => a.startsWith("--reviewer="))?.split("=")[1];

const TEXT_SCORE = Prisma.sql`GREATEST(
  similarity(rio_fold_text(a.title), rio_fold_text(b.title)),
  similarity(rio_fold_text(a.statement), rio_fold_text(b.statement))
)`;
const SCORE = Prisma.sql`CASE
  WHEN dc.scope <> 'cross_org'
   AND a.reference_id IS NOT NULL AND btrim(a.reference_id) <> '' AND a.reference_id = b.reference_id
   AND (SELECT count(*) FROM needs r
         WHERE r.org_id = a.org_id AND r.reference_id = a.reference_id
           AND r.merged_into_need_id IS NULL) <= 2
  THEN 1
  ELSE ${TEXT_SCORE}
END`;

interface Row {
  id: string;
  org_id: string | null;
  scope: string;
  old_score: string;
  new_score: string;
  threshold: string;
}

async function main(): Promise<void> {
  console.log(`\nUAT DQ-06/DQ-10 — re-score pending literal duplicate pairs (${APPLY ? "APPLY" : "dry run"})\n`);

  const rows = await supervisor.$queryRaw<Row[]>`
    SELECT dc.id, dc.org_id, dc.scope, dc.score::text AS old_score,
           (${SCORE})::numeric(5,4)::text AS new_score, dc.threshold::text AS threshold
      FROM duplicate_candidates dc
      JOIN needs a ON a.id = dc.need_a_id
      JOIN needs b ON b.id = dc.need_b_id
     WHERE dc.method = 'literal' AND dc.status = 'pending'`;

  const dismiss = rows.filter((r) => Number(r.new_score) < Number(r.threshold));
  const byScope = (list: Row[]) =>
    list.reduce<Record<string, number>>((acc, r) => ((acc[r.scope] = (acc[r.scope] ?? 0) + 1), acc), {});
  console.log("pending literal pairs:", rows.length, byScope(rows));
  console.log("would be dismissed:   ", dismiss.length, byScope(dismiss));
  console.log("stay in the queue:    ", rows.length - dismiss.length);

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply --reviewer=<email> to apply.\n");
    return;
  }
  if (!REVIEWER) throw new Error("--apply needs --reviewer=<email of the person applying this>");
  const reviewer = await supervisor.user.findUnique({ where: { email: REVIEWER }, select: { id: true } });
  if (!reviewer) throw new Error(`No user with email ${REVIEWER}`);

  // duplicate_candidates FORCES row-level security, so each entity's pairs are
  // written under that entity's org context, and cross-entity pairs (org_id
  // NULL) with the org unset. The scores written are the ones computed above
  // with the supervisor client, by pair id — re-joining `needs` here would
  // see only one org's needs, and for cross-entity pairs none at all (UAT
  // DQ-10). applyRescoredPairs refuses to dismiss if any score did not land,
  // so the apply pass can't disagree with the dry run.
  const orgs = [...new Set(rows.map((r) => r.org_id))];
  let dismissed = 0;
  for (const orgId of orgs) {
    const pairs = rows
      .filter((r) => r.org_id === orgId)
      .map((r) => ({ id: r.id, score: Number(r.new_score) }));
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId ?? ""}, true)`;
      dismissed += await applyRescoredPairs(tx, pairs, null, reviewer.id);
    });
  }
  console.log(`\nDismissed ${dismissed} pair(s), attributed to ${REVIEWER}.\n`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await supervisor.$disconnect();
    await app.$disconnect();
  });
