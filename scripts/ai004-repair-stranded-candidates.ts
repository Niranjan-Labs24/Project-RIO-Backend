import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";

/**
 * RIO-AI-004 — one-off repair for duplicate pairs stranded by a merge.
 *
 * ─── What went wrong ────────────────────────────────────────────────────────
 * Until 4 Sep, a merge closed only the candidate it was launched from. Any
 * OTHER open pair that mentioned the retired need stayed pending, so the
 * reviewer queue kept offering proposals about a need that no longer exists as
 * a live record. Opening one gets ALREADY_MERGED and there is no decision the
 * reviewer can usefully make — the question was already answered by the merge.
 *
 * NeedMergeService now closes them all at merge time (and reopens them on
 * undo). This script repairs the rows created before that fix.
 *
 * ─── What it writes, and why that attribution ───────────────────────────────
 * status -> 'superseded', which is what the fix would have written: the pair
 * was not merged, it stopped being decidable.
 *
 * reviewed_by / reviewed_at are taken from the MERGE that retired the need,
 * not from whoever runs this script. A CHECK requires a decided row to name a
 * reviewer, and inventing one — or attributing it to an operator running a
 * repair weeks later — would put a false name in a column people read to find
 * out who decided something. The merge is what superseded the pair, so the
 * person who performed the merge is the honest answer.
 *
 * Idempotent and read-only where it can be: run it twice and the second run
 * reports nothing to do.
 */

// Read across entities with the supervisor role, write with the application
// role under the row's own org context — exactly how the application does it.
// The supervisor role holds SELECT and nothing else by design, and
// duplicate_candidates FORCES row-level security, so a write has to set
// app.current_org_id the way a request would.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.SUPERVISOR_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});
const appPrisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
});

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  console.log("\nRIO-AI-004 — stranded duplicate candidates\n");

  const stranded = await prisma.$queryRawUnsafe<
    {
      id: string;
      org_id: string | null;
      method: string;
      status: string;
      retired_need_id: string;
      decided_by: string | null;
      merged_at: Date | null;
    }[]
  >(`
    SELECT DISTINCT d.id, d.org_id, d.method, d.status,
           n.id  AS retired_need_id,
           m.decided_by,
           m.decided_at AS merged_at
      FROM duplicate_candidates d
      JOIN needs n
        ON (n.id = d.need_a_id OR n.id = d.need_b_id)
       AND n.merged_into_need_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT nm.decided_by, nm.decided_at
          FROM need_merges nm
         WHERE nm.retired_need_id = n.id
           AND nm.undone_at IS NULL
         ORDER BY nm.decided_at DESC
         LIMIT 1
      ) m ON TRUE
     WHERE d.status IN ('pending', 'confirmed_duplicate')
  `);

  if (stranded.length === 0) {
    console.log("  Nothing to repair — no open pair references a merged need.\n");
    return;
  }

  console.log(`  ${stranded.length} open pair(s) reference a need that has been merged:\n`);
  for (const row of stranded) {
    console.log(
      `    ${row.id}  ${row.method}/${row.status}  retired need ${row.retired_need_id}` +
        `  merged by ${row.decided_by ?? "(unknown)"}`,
    );
  }

  const withoutMerge = stranded.filter((r) => !r.decided_by || !r.merged_at);
  if (withoutMerge.length > 0) {
    // Refuse rather than guess. A decided row must name a real reviewer, and
    // there is no honest value to put here if no merge record explains why the
    // need is retired.
    console.log(
      `\n  ${withoutMerge.length} of these have no matching merge record. ` +
        `Not repairing any of them — investigate first.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log("\n  Dry run. Re-run with --apply to write the change.\n");
    return;
  }

  let repaired = 0;
  for (const row of stranded) {
    await appPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_org_id', $1, true)`,
        row.org_id ?? '',
      );
      const count = await tx.$executeRawUnsafe(
        `UPDATE duplicate_candidates
            SET status = 'superseded', reviewed_by = $1::uuid, reviewed_at = $2::timestamptz
          WHERE id = $3::uuid AND status IN ('pending', 'confirmed_duplicate')`,
        row.decided_by,
        row.merged_at,
        row.id,
      );
      repaired += count;
    });
  }
  console.log(`\n  Repaired ${repaired} pair(s), attributed to the merge that retired the need.\n`);
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]));
