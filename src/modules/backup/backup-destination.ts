import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/**
 * RIO-NFR-010 / Q34 — where a backup goes, and whether it is encrypted.
 *
 * ─── What is decided and what is not ────────────────────────────────────────
 * Q34 is unanswered: destination, encryption, key custody and residency are all
 * the client's to give. What IS decidable now is the shape, so that answering
 * Q34 costs one adapter and one environment variable rather than a redesign.
 *
 * So this file defines the seam and ships the only destination we can honestly
 * offer today — the local filesystem, which is where BACKUP_DIR already points.
 *
 * ─── Encryption ─────────────────────────────────────────────────────────────
 * AES-256-GCM, off by default, key from configuration. Deliberately off rather
 * than on-with-a-generated-key: a backup encrypted with a key nobody has
 * escrowed is not a backup, it is a very tidy way to lose data. Turning it on
 * is a decision that must be taken together with deciding who holds the key,
 * which is exactly what Q34 asks.
 *
 * GCM rather than CBC because a backup must be detectably intact, not merely
 * unreadable: the auth tag makes tampering or truncation fail loudly at restore
 * instead of producing plausible garbage.
 *
 * ─── What is deliberately NOT here ──────────────────────────────────────────
 * No S3 or Azure adapter. Writing one against a destination the client has not
 * chosen would be guessing at credentials, region and retention semantics, and
 * an untested cloud writer in a disaster-recovery path is worse than an honest
 * gap. The interface is the commitment; the adapter follows the answer.
 */

/** File format written when encryption is on. Version prefix so a future
 *  algorithm change is detectable at restore rather than silently wrong. */
const MAGIC = Buffer.from('RIOBK1\n', 'utf8');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface StoredArtefact {
  /** Where the artefact now lives, in whatever the destination calls a path. */
  location: string;
  /** Bytes as stored, which differs from the plaintext size when encrypted. */
  sizeBytes: number;
  encrypted: boolean;
}

export interface BackupDestination {
  readonly name: string;
  /** True when written artefacts are encrypted at rest by this destination. */
  readonly encrypts: boolean;
  /**
   * Take a file that has just been written locally and put it where it belongs.
   * Returns where it ended up — the caller records that, not the temporary path.
   */
  store(localPath: string): Promise<StoredArtefact>;
}

/**
 * The default: leave the file where pg_dump wrote it, optionally encrypting it
 * in place.
 *
 * "Local disk" is not a disaster-recovery destination — a backup on the machine
 * it protects survives a bad migration and nothing else. That is a Q34 decision
 * to make, not a gap to hide, and BackupService says so on the screen.
 */
export class LocalFilesystemDestination implements BackupDestination {
  readonly name = 'local-filesystem';

  constructor(private readonly encryptionKey?: string) {}

  get encrypts(): boolean {
    return !!this.encryptionKey;
  }

  async store(localPath: string): Promise<StoredArtefact> {
    const { stat } = await import('node:fs/promises');
    if (!this.encryptionKey) {
      const stats = await stat(localPath);
      return { location: localPath, sizeBytes: stats.size, encrypted: false };
    }

    // Written beside the original and swapped in only on success: a crash
    // mid-encryption must not leave a half-written file wearing the name of a
    // backup that the run row says succeeded.
    const encryptedPath = `${localPath}.enc`;
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    // scrypt rather than a raw key: the configured value is a passphrase, and
    // deriving with a per-file salt means two backups never share a key stream.
    const key = scryptSync(this.encryptionKey, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);

    const out = createWriteStream(encryptedPath);
    out.write(MAGIC);
    out.write(salt);
    out.write(iv);
    await pipeline(createReadStream(localPath), cipher, out);
    // The auth tag is only available once the cipher has finished, so it is
    // appended after the body. Restore reads it from the end of the file.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(encryptedPath, cipher.getAuthTag());

    await unlink(localPath);
    await rename(encryptedPath, localPath);

    const stats = await stat(localPath);
    return { location: localPath, sizeBytes: stats.size, encrypted: true };
  }
}

/** Header length, exported so a restore tool can seek past it. */
export const ENCRYPTED_HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
export const ENCRYPTED_TAG_BYTES = TAG_BYTES;
