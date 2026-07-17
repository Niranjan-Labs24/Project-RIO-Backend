import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config.service';

// RIO-FR-Add-01: only these evidence file types are accepted; everything
// else (executables, arbitrary docs) is rejected. Images (JPG/JPEG/PNG) are
// allowed alongside documents/spreadsheets — evidence photos, not just paperwork.
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.csv',
  '.xls',
  '.xlsx',
  '.doc',
  '.docx',
  '.jpg',
  '.jpeg',
  '.png',
]);

// Per Ganesh: 10MB per file, 10 files per study (so 100MB per study max).
export const MAX_EVIDENCE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_EVIDENCE_FILES_PER_STUDY = 10;

@Injectable()
export class EvidenceStorageService {
  constructor(private readonly config: ConfigService) {}

  assertAllowedExtension(originalName: string): string {
    const ext = extname(originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new BadRequestException({
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          message: 'Only PDF, CSV, XLS, XLSX, DOC, DOCX, JPG, JPEG and PNG files are accepted.',
        },
      });
    }
    return ext;
  }

  assertAllowedSize(originalName: string, sizeBytes: number): void {
    if (sizeBytes > MAX_EVIDENCE_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        error: {
          code: 'FILE_TOO_LARGE',
          message: `"${originalName}" exceeds the 10MB per-file limit.`,
        },
      });
    }
  }

  assertFileSignature(originalName: string, buffer: Buffer): void {
    const ext = this.assertAllowedExtension(originalName);
    const hex = buffer.subarray(0, 8).toString('hex');
    const ascii = buffer.subarray(0, 5).toString('ascii');
    const matches =
      (ext === '.pdf' && ascii === '%PDF-') ||
      ((ext === '.jpg' || ext === '.jpeg') && hex.startsWith('ffd8ff')) ||
      (ext === '.png' && hex === '89504e470d0a1a0a') ||
      ((ext === '.docx' || ext === '.xlsx') && hex.startsWith('504b0304')) ||
      ((ext === '.doc' || ext === '.xls') && hex.startsWith('d0cf11e0a1b11ae1')) ||
      (ext === '.csv' && !buffer.subarray(0, 4096).includes(0));
    if (!matches) {
      throw new BadRequestException({
        error: { code: 'FILE_CONTENT_MISMATCH', message: `"${originalName}" does not match its declared file type.` },
      });
    }
  }

  // Hashes the in-memory upload buffer directly — never re-read from
  // storageKey/disk, so this must be called with the same buffer passed
  // to save(), before or after, not derived from the saved file.
  hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  async save(originalName: string, buffer: Buffer): Promise<string> {
    const ext = this.assertAllowedExtension(originalName);
    const dir = resolve(this.config.evidenceStoragePath);
    await mkdir(dir, { recursive: true });
    const storageKey = `${randomUUID()}${ext}`;
    await writeFile(join(dir, storageKey), buffer);
    return storageKey;
  }

  async remove(storageKey: string): Promise<void> {
    const dir = resolve(this.config.evidenceStoragePath);
    await unlink(join(dir, storageKey)).catch(() => undefined);
  }
}
