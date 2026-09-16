export interface BackupResult {
  success: boolean;
  /** The `backup_runs` row this attempt produced. AC 2's auditable record. */
  runId?: string;
  filePath?: string;
  fileName?: string;
  sizeBytes?: number;
  /** SHA-256 of the artefact, so a later restore can prove it is intact. */
  sha256?: string;
  /** Files captured by an attachment run. Undefined for a database run. */
  fileCount?: number;
  durationMs: number;
  error?: string;
}

export type BackupKind = 'database' | 'attachments';
export type BackupTrigger = 'schedule' | 'manual';

export interface BackupRunView {
  id: string;
  kind: BackupKind;
  status: 'running' | 'succeeded' | 'failed';
  trigger: BackupTrigger;
  triggeredBy: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  fileCount: number | null;
  retainUntil: Date | null;
  prunedAt: Date | null;
  error: string | null;
}

export interface BackupSummary {
  /** The number an admin opens this screen to check. */
  lastSuccessfulDatabase: Date | null;
  lastSuccessfulAttachments: Date | null;
  failuresLast7Days: number;
  totalSizeBytes: number;
}

/**
 * RIO-NFR-010 AC 1 — the answer to "can this backup actually be restored",
 * which is a different and harder question than "is the file intact".
 */
export interface RecoverabilityCheck {
  /** True only when the artefact both matches its checksum AND parses. */
  ok: boolean;
  /** Whether the cheap half passed — separated so a caller can say which failed. */
  checksumOk: boolean;
  /** Why not: CHECKSUM_MISMATCH, NO_TABLE_DATA, MANIFEST_MISMATCH, ... */
  reason: string | null;
  checkedAt: Date;
  durationMs: number;
  /**
   * What the structural check saw — table-data entries for a dump, files
   * verified against the manifest for an attachment archive. Shown on screen
   * because "recoverable" with no number behind it is a claim, not evidence.
   */
  detail: {
    tocEntries?: number;
    tableDataEntries?: number;
    filesVerified?: number;
    filesExpected?: number;
  };
}
