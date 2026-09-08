export interface ImportNeedRowError {
  row: number;
  message: string;
  // 'duplicate' — the row matches a Need already in this Study (or an
  // earlier row in the same file); 'validation' — anything else (missing
  // required field, etc). Lets the client tell the two apart without
  // string-matching `message`.
  type: 'duplicate' | 'validation';
  // Which column the problem is in. Added for RIO-FR-002, which turns these
  // rejections into cleaning_flags rows and needs a real field name for the
  // flag — sniffing it out of `message` would break the moment that
  // user-facing text is localised. Optional so no existing caller changes.
  field?: string;
}

export interface ImportNeedsResult {
  totalRows: number;
  imported: number;
  failed: number;
  errors: ImportNeedRowError[];
}

export interface ParsedPdfNeedItem {
  id: string;
  title: string;
  statement: string;
  village?: string;
  referenceId?: string;
}

export interface PdfPreviewResult {
  totalExtracted: number;
  needs: ParsedPdfNeedItem[];
}

export interface BulkImportNeedItem {
  title: string;
  statement: string;
  village?: string;
  referenceId?: string;
  /** Whole number of people, or omitted — the need-entry form's "roughly how
   *  many people does this need affect?" answer, carried through the bulk
   *  path so an import isn't a way to lose the field. */
  affectedPopulation?: number;
}

export interface BulkImportNeedsPayload {
  needs: BulkImportNeedItem[];
}
