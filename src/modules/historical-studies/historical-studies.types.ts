export interface HistoricalStudyRow {
  id: string;
  orgId: string;
  title: string;
  region: string[];
  governorateIds: string[];
  centerIds: string[];
  targetSector: string | null;
  studyDate: Date;
  author: string;
  methodologyVersionLabel: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  fileHash: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface HistoricalStudy {
  id: string;
  orgId: string;
  orgName: string;
  title: string;
  region: string[];
  governorateIds: string[];
  governorateNames: string[];
  centerIds: string[];
  centerNames: string[];
  targetSector: string | null;
  studyDate: string;
  author: string;
  methodologyVersionLabel: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
}

export interface UploadedHistoricalStudyFile {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}

export interface CreateHistoricalStudyPayload {
  title: string;
  region: string[];
  governorateIds: string[];
  centerIds: string[];
  targetSector?: string;
  studyDate: string;
  author: string;
  methodologyVersionLabel: string;
  file: UploadedHistoricalStudyFile;
}

// RIO-DATA-002 — the outcome of turning an archived pre-platform study
// (RIO-FR-013) into a real Study + Need rows so it lands in the unified
// dashboard. The row counts and `errors` are the standard needs-import
// report flattened in, so the client can render row-level errors exactly as
// it does for a normal study import.
export interface HistoricalStudyImportResult {
  historicalStudyId: string;
  studyId: string;
  studyTitle: string;
  cycleNumber: number;
  totalRows: number;
  imported: number;
  failed: number;
  errors: Array<{ row: number; message: string; type: 'duplicate' | 'validation' }>;
}

// File extensions the importer can actually read. PDF is deliberately
// excluded: the needs module only parses PDFs through a preview-and-confirm
// flow that needs a human in the loop, which does not fit a one-shot
// "import this archive entry" action.
export const IMPORTABLE_HISTORICAL_EXTENSIONS = ['.csv', '.xlsx', '.xls'] as const;
