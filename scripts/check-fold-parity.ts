// RIO-FR-002 — assert that foldText() and rio_fold_text() agree.
//
// Run:  pnpm check:fold-parity
//
// Why this exists as a script and not only as a unit test: the unit test pins
// the TypeScript side to FOLD_FIXTURES, and the fixtures pin the expected
// output — but nothing in the test suite ever asks the DATABASE what it thinks.
// Four functional GIN indexes are built over rio_fold_text's output. If the
// two implementations drift, this module proposes matches the indexes cannot
// find, duplicate detection quietly misses pairs, and no error is raised
// anywhere. That failure is silent by construction, so it needs a check that
// crosses the boundary on purpose.
//
// Run it after any change to either implementation, and after any Postgres
// major-version or collation change.

// Same env convention as prisma.config.ts — this runs outside Nest, so
// nothing else has loaded .env for it.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { FOLD_FIXTURES } from "../src/modules/data-cleaning/normalizers/fold-text.fixtures";
import { foldText } from "../src/modules/data-cleaning/normalizers/fold-text";

// Prisma 7 requires an explicit driver adapter. This runs as the schema
// owner (DATABASE_URL), not the restricted app role, because it only ever
// evaluates a function and never touches a row.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

interface Mismatch {
  label: string;
  input: string;
  fromTypeScript: string;
  fromDatabase: string;
}

async function main(): Promise<void> {
  const mismatches: Mismatch[] = [];

  for (const fixture of FOLD_FIXTURES) {
    const rows = await prisma.$queryRaw<{ folded: string }[]>`
      SELECT rio_fold_text(${fixture.input}) AS folded
    `;
    const fromDatabase = rows[0]?.folded ?? "";
    const fromTypeScript = foldText(fixture.input);

    if (fromDatabase !== fromTypeScript) {
      mismatches.push({
        label: fixture.label,
        input: fixture.input,
        fromTypeScript,
        fromDatabase,
      });
    }

    // The fixtures are the contract both sides are held to, so a database
    // that agrees with TypeScript but not with the fixture is still a
    // failure — it means both were changed and the contract was not.
    if (fromDatabase !== fixture.expected) {
      mismatches.push({
        label: `${fixture.label} (vs fixture)`,
        input: fixture.input,
        fromTypeScript: fixture.expected,
        fromDatabase,
      });
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `\nfoldText() and rio_fold_text() disagree on ${mismatches.length} of ${FOLD_FIXTURES.length} fixtures.\n`,
    );
    for (const m of mismatches) {
      console.error(`  ${m.label}`);
      console.error(`    input:      ${JSON.stringify(m.input)}`);
      console.error(`    TypeScript: ${JSON.stringify(m.fromTypeScript)}`);
      console.error(`    Postgres:   ${JSON.stringify(m.fromDatabase)}`);
    }
    console.error(
      "\nFix both sides, then REINDEX every functional index over rio_fold_text:\n" +
        "  needs_title_folded_trgm_idx, needs_statement_folded_trgm_idx,\n" +
        "  centers_name_folded_trgm_idx, governorates_name_folded_trgm_idx\n",
    );
    process.exit(1);
  }

  console.log(
    `foldText() and rio_fold_text() agree on all ${FOLD_FIXTURES.length} fixtures.`,
  );
}

main()
  .catch((err) => {
    console.error("check-fold-parity failed:", err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
