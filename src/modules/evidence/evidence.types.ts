export interface EvidenceRow {
  id: string;
  studyId: string;
  orgId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storageKey: string;
  // Null only for rows written before the column existed — they can't be
  // backfilled (the hash comes from the upload buffer, not from disk), so
  // they're simply skipped by duplicate detection.
  fileHash: string | null;
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
  // Set only on the upload response — true if a file with the same sha256
  // already existed in this Study (including an earlier file in the same
  // upload batch) when this row was created. Not blocking; not present on
  // listByStudyId's response.
  isDuplicate?: boolean;
}

export interface UploadedFilePayload {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}
