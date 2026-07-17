export interface EvidenceRow {
  id: string;
  studyId: string;
  orgId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface Evidence {
  id: string;
  studyId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  // `uploadedBy` stays the raw user id (traceability, RIO-NFR-002) — this is
  // purely an additive display convenience alongside it, resolved from the
  // org's user table. Null only if the uploader's user record no longer
  // exists (e.g. removed since).
  uploadedBy: string;
  uploadedByName: string | null;
  uploadedAt: string;
}

export interface UploadedFilePayload {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}
