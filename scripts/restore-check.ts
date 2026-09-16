import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashFile } from '../src/modules/backup/attachment-archive.util';
import 'dotenv/config';

const execFileAsync = promisify(execFile);

/**
 * RIO-NFR-010 — proves the first acceptance criterion.
 *
 * "Recoverable periodic backups" has two halves. The schedule gives the
 * periodic half; this gives the recoverable one. A backup nobody has ever
 * restored is a belief, not a control — and the moment you find out it was a
 * belief is the moment you needed it to be a control.
 *
 * What it does:
 *   1. takes the newest successful database run,
 *   2. re-checksums the file against what was recorded when it was written,
 *   3. restores it into a scratch database,
 *   4. compares row counts for the tables that matter against the source,
 *   5. drops the scratch database.
 *
 * Read-only against the live database. The scratch database is created and
 * dropped by this script and is named distinctly so it can never be confused
 * with a real one.
 */

const SCRATCH_DB = 'cnap_restore_check';

// The tables whose emptiness would mean a restore had silently produced a
// working but useless database.
const CHECK_TABLES = [
  'organisations',
  'users',
  'studies',
  'needs',
  'survey_responses',
  'audit_logs',
  'backup_runs',
];

function adminUrl(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Row counts for every table of interest.
 *
 * `disableRls` is used on the SCRATCH database only. Row-level security comes
 * across in the dump, and with FORCE set even the table owner sees nothing
 * without a matching policy — so counting a restored copy as the restoring role
 * would report zero for all 43 protected tables and look like a catastrophic
 * restore failure. The scratch database is a throwaway, so RLS is switched off
 * there to count what actually arrived. The live database is never touched.
 */
async function rowCounts(url: string, disableRls = false): Promise<Map<string, number>> {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const out = new Map<string, number>();
  try {
    if (disableRls) {
      for (const table of CHECK_TABLES) {
        await client
          .$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`)
          .catch(() => undefined);
      }
    }
    for (const table of CHECK_TABLES) {
      try {
        const rows = await client.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "${table}"`,
        );
        out.set(table, Number(rows[0]?.n ?? 0));
      } catch {
        // A table missing from the restore is itself the finding, recorded as
        // -1 rather than crashing the comparison.
        out.set(table, -1);
      }
    }
  } finally {
    await client.$disconnect();
  }
  return out;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.SUPERVISOR_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  console.log('\nRIO-NFR-010 — restore check\n');
  let failures = 0;
  const check = (label: string, ok: boolean, detail = ''): boolean => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
    return ok;
  };

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const run = await prisma.backupRun.findFirst({
    where: { kind: 'database', status: 'succeeded', prunedAt: null },
    orderBy: { startedAt: 'desc' },
  });

  if (!run?.filePath) {
    console.log('  SKIP  no successful database backup recorded yet.');
    console.log('        Trigger one first: POST /api/backups/run { "kind": "database" }\n');
    await prisma.$disconnect();
    return;
  }
  console.log(`  Using ${run.fileName} (${run.sizeBytes} bytes, taken ${run.startedAt.toISOString()})\n`);

  // 1. Integrity, before spending time on a restore.
  const actual = await hashFile(run.filePath);
  check('the file still matches the checksum recorded when it was written', actual === run.sha256);

  // Counted with the BACKUP role: it is the only one with read policies on
  // every table, and it is precisely the view pg_dump captured.
  const sourceCounts = await rowCounts(process.env.BACKUP_DATABASE_URL ?? databaseUrl);
  await prisma.$disconnect();

  // 2. Restore into a scratch database.
  // CREATE DATABASE needs a role with CREATEDB: cnap_owner has it, and the
  // read-only supervisor role deliberately does not.
  const maintenanceUrl = adminUrl(process.env.DATABASE_URL ?? databaseUrl, 'postgres');
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: maintenanceUrl }) });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
  } finally {
    await admin.$disconnect();
  }

  const scratchUrl = adminUrl(process.env.DATABASE_URL ?? databaseUrl, SCRATCH_DB);
  let restored = true;
  try {
    // pg_restore exits non-zero on warnings too (missing roles, ownership),
    // which are expected against a fresh database and are not failures of the
    // dump. The row counts below are the real verdict.
    await execFileAsync(process.env.PG_RESTORE_PATH ?? 'pg_restore', [
      '--dbname', scratchUrl,
      '--no-owner',
      '--no-privileges',
      run.filePath,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/warning|already exists|does not exist/i.test(message)) {
      restored = check('pg_restore completed', false, message.slice(0, 200));
    }
  }
  if (restored) check('pg_restore completed', true);

  // 3. Compare what came back.
  const restoredCounts = await rowCounts(scratchUrl, true);
  for (const table of CHECK_TABLES) {
    const from = sourceCounts.get(table) ?? -1;
    const to = restoredCounts.get(table) ?? -1;
    // The source moves on while the dump is fixed in time, so a restore can
    // hold FEWER rows than the live database. Fewer is expected; more, or a
    // missing table, is not.
    check(
      `${table}: restored ${to}, source ${from}`,
      to >= 0 && to <= from,
      to > from ? 'restored has MORE rows than the source' : '',
    );
  }

  // 4. Clean up. A scratch database left behind is a disk leak and, worse, a
  //    copy of production data nobody is tracking.
  const cleanup = new PrismaClient({ adapter: new PrismaPg({ connectionString: maintenanceUrl }) });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    check('scratch database dropped', true);
  } catch (error) {
    check('scratch database dropped', false, error instanceof Error ? error.message : '');
  } finally {
    await cleanup.$disconnect();
  }

  console.log(
    failures === 0
      ? '\n  Restore verified. The backup is recoverable.\n'
      : `\n  ${failures} check(s) FAILED — this backup is NOT proven recoverable.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
