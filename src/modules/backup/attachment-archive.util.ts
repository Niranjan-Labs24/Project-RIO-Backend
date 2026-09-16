import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

/**
 * RIO-NFR-010 / Q33 — the attachments half of a backup.
 *
 * A database dump alone is not a recoverable backup of this platform. Evidence
 * documents live on disk under EVIDENCE_STORAGE_PATH and only their metadata is
 * in Postgres, so restoring the database without them produces rows pointing at
 * files that no longer exist — needs with evidence attached that cannot be
 * opened. Both halves, or neither.
 *
 * ─── Why a manifest, not just an archive ────────────────────────────────────
 * Every file is recorded with its size and SHA-256 before it goes into the
 * archive. That gives a restore something to verify against file by file, and
 * it makes a partial or silently truncated capture visible — an archive alone
 * only tells you it unpacked, not that everything is in it.
 */

export interface ManifestEntry {
  /** Path relative to the storage root, so a restore is location-independent. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface AttachmentArchiveOutcome {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  fileCount: number;
  manifestPath: string;
}

export function buildAttachmentFileName(now: Date = new Date()): string {
  // Same portability reasoning as buildBackupFileName: colons and periods are
  // not safe in filenames on every filesystem this may run on.
  const iso = now.toISOString().replace(/[:.]/g, '-');
  return `cnap-attachments-${iso}.tar.gz`;
}

/** Every file under `root`, depth-first, as paths relative to it. */
async function walk(root: string, current = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    // A missing storage directory is not a failure: an installation with no
    // evidence uploaded yet has nothing to archive, and reporting that as a
    // broken backup would train people to ignore the alert.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    // Symlinks are deliberately not followed: an attacker-placed link could
    // otherwise pull arbitrary host files into a backup that leaves the
    // machine.
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Archive the evidence tree with a manifest beside it.
 *
 * Uses `tar` through Node rather than shelling out, so the same code path runs
 * on the Windows dev machines this team uses and in the Linux container.
 */
export async function archiveAttachments(params: {
  storagePath: string;
  backupDir: string;
  now?: Date;
}): Promise<AttachmentArchiveOutcome> {
  const root = resolve(params.storagePath);
  const dir = resolve(params.backupDir);
  await mkdir(dir, { recursive: true });

  const relativePaths = await walk(root);
  const manifest: ManifestEntry[] = [];
  for (const relPath of relativePaths) {
    const full = join(root, relPath);
    const stats = await stat(full);
    manifest.push({
      path: relPath,
      sizeBytes: stats.size,
      sha256: await hashFile(full),
    });
  }

  const fileName = buildAttachmentFileName(params.now);
  const filePath = join(dir, fileName);
  const manifestPath = `${filePath}.manifest.json`;

  // The archive is written as a gzipped stream of a simple, self-describing
  // container: a JSON header line, then each file's bytes in manifest order.
  // Deliberately not a third-party tar dependency — the format only has to be
  // readable by scripts/restore-check.ts, which ships alongside it, and adding
  // a dependency to a disaster-recovery path is a liability of its own.
  const gzip = createGzip();
  const out = createWriteStream(filePath);
  const done = pipeline(gzip, out);

  gzip.write(`${JSON.stringify({ format: 'cnap-attachments-v1', files: manifest })}\n`);
  const { createReadStream } = await import('node:fs');
  for (const entry of manifest) {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const read = createReadStream(join(root, entry.path));
      read.on('error', rejectWrite);
      read.on('end', () => resolveWrite());
      read.pipe(gzip, { end: false });
    });
  }
  gzip.end();
  await done;

  const { writeFile } = await import('node:fs/promises');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const stats = await stat(filePath);
  return {
    filePath,
    fileName,
    sizeBytes: stats.size,
    sha256: await hashFile(filePath),
    fileCount: manifest.length,
    manifestPath,
  };
}
