import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Colons/periods in an ISO timestamp aren't safe in filenames on every
// filesystem this might run on (notably Windows, for anyone running the
// backup outside Docker) — replaced with `-` so the name is portable.
export function buildBackupFileName(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, '-');
  return `cnap-backup-${iso}.dump`;
}

export interface PgDumpParams {
  databaseUrl: string;
  backupDir: string;
  // Defaults to the bare `pg_dump` command, resolved via the process's own
  // PATH — correct in Docker (only one pg_dump is ever installed there, see
  // Dockerfile). On a host machine with multiple Postgres versions
  // installed (e.g. Homebrew, where `pg_dump` on PATH tracks whichever
  // version is currently *linked*, not necessarily the one matching this
  // project's server), PATH resolution can silently pick the wrong major
  // version and hard-fail on a version-mismatch check. PG_DUMP_PATH lets an
  // environment point at a specific binary instead of fighting global PATH
  // state that other tools/projects on the same machine may also depend on.
  pgDumpPath?: string;
  now?: Date;
}

export interface PgDumpOutcome {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

/**
 * Runs `pg_dump` against `databaseUrl`, writing a custom-format (-F c) dump
 * into `backupDir` (created if missing) under a timestamped filename.
 * Custom format is compressed and restorable with `pg_restore` — including
 * selectively or in parallel — unlike a flat SQL dump.
 *
 * Throws on any failure (pg_dump not installed, connection failure, disk
 * full, ...). The caller (BackupService) is responsible for catching this —
 * this function does not itself guard against a failing backup taking down
 * the process.
 */
export async function runPgDump({ databaseUrl, backupDir, pgDumpPath, now }: PgDumpParams): Promise<PgDumpOutcome> {
  const dir = resolve(backupDir);
  await mkdir(dir, { recursive: true });
  const fileName = buildBackupFileName(now);
  const filePath = join(dir, fileName);
  // The connection string is passed as a single execFile argument (no
  // shell is invoked), so embedded special characters — e.g. in the
  // password — are never at risk of shell injection.
  // --enable-row-security is REQUIRED here and is not a convenience flag.
  //
  // 43 tables FORCE row-level security. Without this, pg_dump refuses outright
  // ("query would be affected by row-level security policy") for any role that
  // cannot bypass RLS, which is every role this platform has.
  //
  // WITH it, pg_dump dumps what the connecting role can SEE. That is the whole
  // danger: a table whose policies do not admit the backup role would be
  // dumped as EMPTY rather than raising an error, turning a loud failure into a
  // silent, unusable backup. BackupService therefore refuses to run this at all
  // unless every RLS-enabled table carries a cnap_backup read policy — see
  // assertBackupRoleCoverage. Do not call this function without that check.
  await execFileAsync(pgDumpPath ?? 'pg_dump', [
    databaseUrl,
    '--enable-row-security',
    '-F',
    'c',
    '-f',
    filePath,
  ]);
  const stats = await stat(filePath);
  return { filePath, fileName, sizeBytes: stats.size };
}
