import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma";
import { pgSslFromEnv } from "../src/prisma/pg-ssl";

// One-time backfill: older reports stored the raw methodologyVersionId (a UUID)
// in content.header.methodologyVersion because the snapshot never carried a
// human-readable label. Report content is persisted at generation time, so the
// UUID shows on the report view AND in the PDF/Excel exports (all read the same
// stored content). New reports are already correct (see
// report-summary.service.ts → methodologyVersionLabel and snapshot-to-content).
// This rewrites the UUID to the MethodologyVersion.version string for every
// existing report so legacy reports and their exports read correctly too.
//
//   pnpm fix:report-methodology            (or: tsx prisma/fix-report-methodology-label.ts)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SUPERVISOR bypasses RLS to see every org's reports; the org-scoped client
// performs each write inside its own org context (same split as score-study.ts).
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ssl: pgSslFromEnv() }),
});
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() }),
});

async function main(): Promise<void> {
  const reports = (await supervisor.report.findMany({
    select: { id: true, orgId: true, content: true },
  })) as Array<{ id: string; orgId: string; content: unknown }>;

  // Cache methodologyVersion id → version (global reference table, no RLS).
  const labelById = new Map<string, string | null>();
  const resolve = async (id: string): Promise<string | null> => {
    if (labelById.has(id)) return labelById.get(id) ?? null;
    const mv = await supervisor.methodologyVersion.findUnique({ where: { id }, select: { version: true } });
    labelById.set(id, mv?.version ?? null);
    return mv?.version ?? null;
  };

  let scanned = 0;
  let fixed = 0;
  let skipped = 0;

  for (const report of reports) {
    scanned += 1;
    const content = report.content as { header?: { methodologyVersion?: unknown } } | null;
    const current = content?.header?.methodologyVersion;
    if (typeof current !== "string" || !UUID_RE.test(current)) continue; // already a label

    const label = await resolve(current);
    if (!label) {
      console.warn(`  ! report ${report.id}: no MethodologyVersion for ${current} — left unchanged`);
      skipped += 1;
      continue;
    }

    const nextContent = { ...(content as object), header: { ...content!.header, methodologyVersion: label } };
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${report.orgId}', true)`);
      await tx.report.update({ where: { id: report.id }, data: { content: nextContent as never } });
    });
    console.log(`  ✓ report ${report.id}: ${current} → ${label}`);
    fixed += 1;
  }

  console.log(`\nDone. Scanned ${scanned}, fixed ${fixed}, skipped ${skipped}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.all([supervisor.$disconnect(), prisma.$disconnect()]);
  });
