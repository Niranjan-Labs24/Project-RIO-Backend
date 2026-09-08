import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveAttachments } from './attachment-archive.util';
import { inspectAttachmentArchive, inspectDatabaseDump } from './recoverability.util';

/**
 * RIO-NFR-010 AC 1 — "recoverable", checked rather than assumed.
 *
 * The checksum test one file over proves the bytes did not rot on disk. These
 * prove the artefact is something a restore could actually consume, which is a
 * different claim: a short archive checksums perfectly and restores half the
 * evidence.
 */
describe('inspectAttachmentArchive', () => {
  let storage: string;
  let backups: string;

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'rio-recover-'));
    storage = join(base, 'evidence');
    backups = join(base, 'backups');
    await mkdir(storage, { recursive: true });
  });

  afterEach(async () => {
    await rm(join(storage, '..'), { recursive: true, force: true });
  });

  it('confirms every file in the manifest is present and hashes correctly', async () => {
    await writeFile(join(storage, 'a.pdf'), 'first document');
    await mkdir(join(storage, 'nested'), { recursive: true });
    await writeFile(join(storage, 'nested', 'b.jpg'), 'second document');

    const archive = await archiveAttachments({ storagePath: storage, backupDir: backups });
    const result = await inspectAttachmentArchive(archive.filePath);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.detail).toMatchObject({ filesVerified: 2, filesExpected: 2 });
  });

  it('an empty file is verified, not skipped', async () => {
    // A zero-byte file owes no bytes, so the cursor has to close it the moment
    // it opens — otherwise the archive looks short by one file forever.
    await writeFile(join(storage, 'empty.txt'), '');
    await writeFile(join(storage, 'after.txt'), 'still here');

    const archive = await archiveAttachments({ storagePath: storage, backupDir: backups });
    const result = await inspectAttachmentArchive(archive.filePath);

    expect(result.ok).toBe(true);
    expect(result.detail.filesVerified).toBe(2);
  });

  it('catches a truncated archive — the failure a checksum cannot catch', async () => {
    // The point of the whole module: this file's own checksum would match
    // whatever it was re-hashed to. Only opening it shows the evidence is gone.
    await writeFile(join(storage, 'one.txt'), 'A'.repeat(4096));
    await writeFile(join(storage, 'two.txt'), 'B'.repeat(4096));

    const archive = await archiveAttachments({ storagePath: storage, backupDir: backups });
    await truncate(archive.filePath, Math.floor(archive.sizeBytes / 2));

    const result = await inspectAttachmentArchive(archive.filePath);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('an installation with no evidence yet is recoverable, not broken', async () => {
    const archive = await archiveAttachments({
      storagePath: join(storage, 'nothing-here'),
      backupDir: backups,
    });

    const result = await inspectAttachmentArchive(archive.filePath);

    expect(result.ok).toBe(true);
    expect(result.detail.filesExpected).toBe(0);
  });

  it('refuses a file that is not an attachment archive at all', async () => {
    const bogus = join(backups, 'not-an-archive.tar.gz');
    await mkdir(backups, { recursive: true });
    await writeFile(bogus, 'this is not gzip');

    const result = await inspectAttachmentArchive(bogus);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ARCHIVE_UNREADABLE');
  });
});

describe('inspectDatabaseDump', () => {
  it('reports a non-archive as unreadable rather than passing it', async () => {
    // Passes whether or not pg_restore is installed on the machine running the
    // suite: a missing binary and a rejected file both mean "cannot restore
    // this", which is the answer the caller needs either way.
    const dir = await mkdtemp(join(tmpdir(), 'rio-dump-'));
    const file = join(dir, 'not-a-dump.dump');
    await writeFile(file, 'plain text, definitely not a pg_dump archive');

    const result = await inspectDatabaseDump({ filePath: file });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ARCHIVE_UNREADABLE');
    await rm(dir, { recursive: true, force: true });
  });
});
