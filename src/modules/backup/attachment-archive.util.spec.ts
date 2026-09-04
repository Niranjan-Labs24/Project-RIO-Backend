import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveAttachments, hashFile } from './attachment-archive.util';

/**
 * RIO-NFR-010 / Q33 — the attachment archive must round-trip.
 *
 * A database dump without the evidence files restores rows pointing at
 * documents that no longer exist. This asserts the archive actually contains
 * what the manifest says it does, because "the run succeeded" and "the files
 * are in there" are different claims and only the second one matters during a
 * restore.
 */
describe('archiveAttachments', () => {
  let storage: string;
  let backups: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'rio-attach-'));
    storage = join(base, 'evidence');
    backups = join(base, 'backups');
    await mkdir(storage, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(storage, '..'), { recursive: true, force: true });
  });

  it('records every file with its real size and checksum', async () => {
    await writeFile(join(storage, 'a.pdf'), 'first document');
    await mkdir(join(storage, 'nested'), { recursive: true });
    await writeFile(join(storage, 'nested', 'b.jpg'), 'second document');

    const outcome = await archiveAttachments({ storagePath: storage, backupDir: backups });

    expect(outcome.fileCount).toBe(2);
    const manifest = JSON.parse(await readFile(outcome.manifestPath, 'utf8')) as {
      path: string;
      sizeBytes: number;
      sha256: string;
    }[];

    // Paths are relative and forward-slashed, so a restore is independent of
    // where the tree lived and of which platform wrote it.
    expect(manifest.map((f) => f.path).sort()).toEqual(['a.pdf', 'nested/b.jpg']);

    for (const entry of manifest) {
      const actual = await hashFile(join(storage, entry.path));
      expect(entry.sha256).toBe(actual);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('round-trips: the archive body contains each file, in manifest order', async () => {
    await writeFile(join(storage, 'one.txt'), 'AAA');
    await writeFile(join(storage, 'two.txt'), 'BBBB');

    const outcome = await archiveAttachments({ storagePath: storage, backupDir: backups });

    // Unpack the gzip stream: one JSON header line, then each file's bytes.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      createReadStream(outcome.filePath)
        .pipe(createGunzip())
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
    const raw = Buffer.concat(chunks).toString('utf8');
    const newline = raw.indexOf('\n');
    const header = JSON.parse(raw.slice(0, newline)) as {
      format: string;
      files: { path: string; sizeBytes: number }[];
    };

    expect(header.format).toBe('cnap-attachments-v1');
    expect(header.files).toHaveLength(2);

    // The bodies follow the header in manifest order, concatenated. Slicing by
    // the recorded sizes is exactly what a restore has to do.
    let offset = newline + 1;
    for (const file of header.files) {
      const body = raw.slice(offset, offset + file.sizeBytes);
      const original = await readFile(join(storage, file.path), 'utf8');
      expect(body).toBe(original);
      offset += file.sizeBytes;
    }
  });

  it('treats a missing storage directory as empty, not as a failure', async () => {
    // An installation with no evidence uploaded yet has nothing to archive.
    // Reporting that as a broken backup trains people to ignore the alert.
    const outcome = await archiveAttachments({
      storagePath: join(storage, 'does-not-exist'),
      backupDir: backups,
    });

    expect(outcome.fileCount).toBe(0);
    expect(outcome.sha256).toHaveLength(64);
  });
});
