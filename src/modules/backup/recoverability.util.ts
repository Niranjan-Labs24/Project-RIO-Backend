import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { ManifestEntry } from './attachment-archive.util';

const execFileAsync = promisify(execFile);

/**
 * RIO-NFR-010 — is the artefact actually RESTORABLE, not merely intact.
 *
 * `BackupService.verify()` answers "are these the same bytes we wrote", which
 * catches corruption and truncation on disk and nothing else. It cannot catch
 * the failure that matters more: a file that was never a usable backup in the
 * first place. A dump written by a pg_dump that exited 0 having produced a
 * header and no table data checksums perfectly and restores nothing.
 *
 * So this module opens the artefact and reads its structure:
 *   - a database dump is handed to `pg_restore --list`, which parses the
 *     archive's table of contents. It fails on a truncated, wrong-format or
 *     non-archive file, and the TOC tells us how many tables carry data.
 *   - an attachment archive is decompressed and every file's bytes are hashed
 *     against the manifest recorded when it was written. "The archive unpacks"
 *     and "the evidence is in it" are different claims and only the second one
 *     survives a restore.
 *
 * Neither performs a restore — that is `scripts/restore-check.ts`, which needs
 * a scratch database and is not something to run from an HTTP request. This is
 * the deepest check that is safe to run on a live system, on demand.
 */

export interface RecoverabilityDetail {
  /** Entries in the dump's table of contents (database artefacts only). */
  tocEntries?: number;
  /** How many of those carry table data — 0 means an empty dump. */
  tableDataEntries?: number;
  /** Files verified against the manifest (attachment artefacts only). */
  filesVerified?: number;
  /** Files the manifest claims (attachment artefacts only). */
  filesExpected?: number;
}

export interface RecoverabilityOutcome {
  ok: boolean;
  /** ARCHIVE_UNREADABLE, EMPTY_ARCHIVE, MANIFEST_MISMATCH, ... — null when ok. */
  reason: string | null;
  detail: RecoverabilityDetail;
}

/**
 * Parse a custom-format dump's table of contents.
 *
 * `pg_restore --list` reads the archive header and TOC only: it never connects
 * to a database and never writes anything, which is what makes it safe to run
 * against production from a request handler.
 */
export async function inspectDatabaseDump(params: {
  filePath: string;
  pgRestorePath?: string;
}): Promise<RecoverabilityOutcome> {
  let stdout: string;
  try {
    // maxBuffer raised: a 79-table dump's TOC is a few hundred KB of text, and
    // the default 1 MB is close enough to be worth not gambling on.
    ({ stdout } = await execFileAsync(
      params.pgRestorePath ?? 'pg_restore',
      ['--list', params.filePath],
      { maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    // pg_restore rejects a file that is not an archive, is truncated, or was
    // written by an incompatible major version. All three mean the same thing
    // to the person asking whether they can restore: no.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      // An encrypted artefact reaches here as unreadable too, which is correct
      // — without the key it is not restorable by whoever is asking.
      reason: `ARCHIVE_UNREADABLE: ${message.slice(0, 300)}`,
      detail: {},
    };
  }

  // TOC lines look like `2661; 0 16553 TABLE DATA public needs cnap_owner`.
  // Comment lines start with ';' and carry the archive header.
  const lines = stdout.split('\n').filter((line) => line.trim() && !line.startsWith(';'));
  const tableData = lines.filter((line) => / TABLE DATA /.test(line)).length;

  if (lines.length === 0) {
    return { ok: false, reason: 'EMPTY_ARCHIVE', detail: { tocEntries: 0, tableDataEntries: 0 } };
  }
  if (tableData === 0) {
    // Schema with no data. This is precisely the silent failure the RLS
    // coverage guard exists to prevent, caught here from the other side.
    return {
      ok: false,
      reason: 'NO_TABLE_DATA',
      detail: { tocEntries: lines.length, tableDataEntries: 0 },
    };
  }

  return {
    ok: true,
    reason: null,
    detail: { tocEntries: lines.length, tableDataEntries: tableData },
  };
}

/**
 * Decompress an attachment archive and check every file against the manifest
 * embedded in its header.
 *
 * The format is one JSON header line then each file's bytes in manifest order
 * (see archiveAttachments), so this walks the stream once, slicing by the
 * recorded sizes and hashing as it goes — no temporary files, and memory stays
 * flat regardless of archive size.
 */
export async function inspectAttachmentArchive(filePath: string): Promise<RecoverabilityOutcome> {
  // A holder rather than a bare `let`: the manifest is assigned inside the
  // stream callback below, and TypeScript's control-flow analysis does not
  // follow assignments made in a closure — through a property it does.
  const state: { manifest: ManifestEntry[] | null } = { manifest: null };
  let headerBuffer = Buffer.alloc(0);

  // Cursor through the manifest: which file we are inside, how many of its
  // bytes are still owed, and the running hash of the bytes seen so far.
  let index = 0;
  let remaining = 0;
  let hash = createHash('sha256');
  let verified = 0;
  let mismatch: string | null = null;

  const closeCurrentFile = () => {
    const entry = state.manifest?.[index];
    if (!entry) return;
    if (hash.digest('hex') === entry.sha256) verified += 1;
    else mismatch ??= entry.path;
    index += 1;
    hash = createHash('sha256');
    remaining = state.manifest?.[index]?.sizeBytes ?? 0;
    // A zero-byte file is complete the moment it starts, and there may be
    // several in a row — close them here rather than waiting for bytes that
    // will never come.
    if (state.manifest && index < state.manifest.length && remaining === 0) closeCurrentFile();
  };

  const consume = (chunk: Buffer) => {
    let offset = 0;
    if (state.manifest === null) {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const newline = headerBuffer.indexOf(0x0a);
      if (newline === -1) return;
      const header = JSON.parse(headerBuffer.subarray(0, newline).toString('utf8')) as {
        format: string;
        files: ManifestEntry[];
      };
      if (header.format !== 'cnap-attachments-v1') {
        throw new Error(`UNKNOWN_FORMAT: ${String(header.format)}`);
      }
      state.manifest = header.files;
      // The body starts after the header line; the rest of this chunk is
      // already file bytes.
      chunk = headerBuffer.subarray(newline + 1);
      headerBuffer = Buffer.alloc(0);
      offset = 0;
      remaining = state.manifest[0]?.sizeBytes ?? 0;
      if (state.manifest.length > 0 && remaining === 0) closeCurrentFile();
    }

    while (offset < chunk.length && state.manifest && index < state.manifest.length) {
      const take = Math.min(remaining, chunk.length - offset);
      hash.update(chunk.subarray(offset, offset + take));
      offset += take;
      remaining -= take;
      if (remaining === 0) closeCurrentFile();
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      createReadStream(filePath)
        .on('error', reject)
        .pipe(createGunzip())
        .on('error', reject)
        .on('data', (chunk: Buffer) => {
          try {
            consume(chunk);
          } catch (error) {
            reject(error);
          }
        })
        .on('end', () => resolve());
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `ARCHIVE_UNREADABLE: ${message.slice(0, 300)}`, detail: {} };
  }

  if (state.manifest === null) return { ok: false, reason: 'NO_MANIFEST', detail: {} };

  const expected = state.manifest.length;
  const detail = { filesVerified: verified, filesExpected: expected };

  // An installation with no evidence yet archives zero files, and that is a
  // legitimate, restorable backup — see the walk() note in the archive util.
  if (expected === 0) return { ok: true, reason: null, detail };
  if (mismatch) return { ok: false, reason: `MANIFEST_MISMATCH: ${mismatch}`, detail };
  // Fewer bytes than the manifest promised: the archive is short, whatever the
  // checksum of the compressed file says.
  if (verified !== expected) return { ok: false, reason: 'ARCHIVE_TRUNCATED', detail };

  return { ok: true, reason: null, detail };
}
