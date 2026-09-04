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
