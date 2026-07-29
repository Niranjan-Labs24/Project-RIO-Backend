export interface BackupResult {
  success: boolean;
  filePath?: string;
  fileName?: string;
  sizeBytes?: number;
  durationMs: number;
  error?: string;
}
