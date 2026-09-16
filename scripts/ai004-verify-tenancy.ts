// RIO-AI-004 / Q9 + NFR-003 — prove one entity's need text cannot reach
// another entity's reviewer.
//
//   pnpm ai004:verify-tenancy
//
// READ-ONLY. Exercises the row-level security policy on duplicate_candidates
// directly, because that is where the guarantee actually lives — the client's
// ruling is enforced by Postgres, not by remembering a WHERE clause.
//
// The policy splits the table by the connection's org context:
//   org-scoped connection  -> only that org's candidates, never cross-org
//   no-GUC supervisor path -> only the cross-org candidates
// Anything else is a leak.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function check(label: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main(): Promise<void> {
  console.log("\nRIO-AI-004 / Q9 — cross-entity isolation on duplicate_candidates\n");

  // Everything runs inside one transaction that is rolled back, so the
  // fixtures never persist.
  let failures = 0;
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE needs NO FORCE ROW LEVEL SECURITY");
      const pair = await tx.$queryRawUnsafe<{ id: string; org_id: string }[]>(
        "SELECT id, org_id FROM needs ORDER BY id LIMIT 2",
      );
      await tx.$executeRawUnsafe("ALTER TABLE needs FORCE ROW LEVEL SECURITY");
      if (pair.length < 2) {
        console.log("  Needs at least two needs in the database to build a pair.");
        return;
      }
      const [a, b] = pair as [{ id: string; org_id: string }, { id: string; org_id: string }];
      const [lo, hi] = a.id < b.id ? [a, b] : [b, a];

      const insert = async (orgId: string | null, scope: string, method: string) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO duplicate_candidates
             (org_id, need_a_id, need_b_id, need_a_org_id, need_b_org_id, scope, method, score, threshold, detector_version, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 0.95, 0.85, 'tenancy-check', now())`,
          orgId, lo.id, hi.id, lo.org_id, hi.org_id, scope, method,
        );
      };

      // An org-scoped row, written under that org's context.
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, lo.org_id);
      await insert(lo.org_id, "within_org", "literal");

      // A cross-entity row, written with no org context (the supervisor path).
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '', true)`);
      await insert(null, "cross_org", "semantic");

      const countScopes = async () => {
        const rows = await tx.$queryRawUnsafe<{ scope: string; count: bigint }[]>(
          `SELECT coalesce(scope,'-') AS scope, count(*) AS count FROM duplicate_candidates
            WHERE detector_version = 'tenancy-check' GROUP BY scope`,
        );
        return new Map(rows.map((r) => [r.scope, Number(r.count)]));
      };

      // 1. No org context — the oversight path. Cross-entity rows ONLY.
      const noGuc = await countScopes();
      if (!check("supervisor path sees the cross-entity pair", (noGuc.get("cross_org") ?? 0) === 1)) failures++;
      if (!check("supervisor path does NOT see org-scoped pairs", (noGuc.get("within_org") ?? 0) === 0)) failures++;

      // 2. The owning entity. Its own rows ONLY.
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, lo.org_id);
      const owning = await countScopes();
      if (!check("owning entity sees its own pair", (owning.get("within_org") ?? 0) === 1)) failures++;
      if (
        !check(
          "owning entity CANNOT see the cross-entity pair (Q9)",
          (owning.get("cross_org") ?? 0) === 0,
          "another entity's need text must never reach an NGO reviewer",
        )
      ) failures++;

      // 2b. Deciding a pair, which is what the reviewer actually does.
      //
      // This is the check that would have caught the 404: the decision path
      // was resolving a cross-entity pair to the reviewer's OWN org, and an
      // UPDATE under that GUC matches no row, so a pair on screen could not be
      // decided. The write has to run with no org context, and the policy is
      // what keeps that honest — it reaches the cross-entity rows and nothing
      // else.
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '', true)`);
      const decidedCross = await tx.$executeRawUnsafe(
        `UPDATE duplicate_candidates SET status = 'not_duplicate',
                reviewed_by = '${lo.org_id}'::uuid, reviewed_at = now()
         WHERE scope = 'cross_org' AND detector_version = 'tenancy-check'`,
      );
      if (
        !check(
          "supervisor path CAN decide the cross-entity pair",
          decidedCross === 1,
          `${decidedCross} row(s) updated`,
        )
      ) failures++;

      const decidedOrg = await tx.$executeRawUnsafe(
        `UPDATE duplicate_candidates SET status = 'not_duplicate',
                reviewed_by = '${lo.org_id}'::uuid, reviewed_at = now()
         WHERE scope = 'within_org' AND detector_version = 'tenancy-check'`,
      );
      if (
        !check(
          "supervisor path CANNOT decide an org-owned pair",
          decidedOrg === 0,
          "the write path is confined by the policy, not by the query",
        )
      ) failures++;

      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, lo.org_id);
      const orgTouchingCross = await tx.$executeRawUnsafe(
        `UPDATE duplicate_candidates SET status = 'not_duplicate',
                reviewed_by = '${lo.org_id}'::uuid, reviewed_at = now()
         WHERE scope = 'cross_org' AND detector_version = 'tenancy-check'`,
      );
      if (
        !check(
          "owning entity CANNOT decide the cross-entity pair (Q9)",
          orgTouchingCross === 0,
        )
      ) failures++;

      // 3. An unrelated entity. Nothing at all.
      await tx.$executeRawUnsafe("ALTER TABLE organisations NO FORCE ROW LEVEL SECURITY");
      const others = await tx.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM organisations WHERE id <> $1::uuid LIMIT 1",
        lo.org_id,
      );
      await tx.$executeRawUnsafe("ALTER TABLE organisations FORCE ROW LEVEL SECURITY");
      if (others.length > 0) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', $1, true)`, others[0]!.id);
        const stranger = await countScopes();
        const total = [...stranger.values()].reduce((s, n) => s + n, 0);
        if (!check("an unrelated entity sees nothing", total === 0, `saw ${total} row(s)`)) failures++;
      } else {
        console.log("  SKIP  only one organisation in this database");
      }

      throw new Error("__ROLLBACK__");
    });
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "__ROLLBACK__") throw err;
  }

  console.log(
    failures === 0
      ? "\n  All isolation checks passed. Fixtures rolled back — nothing persisted.\n"
      : `\n  ${failures} check(s) FAILED.\n`,
  );
  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("ai004-verify-tenancy failed:", e);
    process.exit(1);
  })
  .finally(() => void owner.$disconnect());
