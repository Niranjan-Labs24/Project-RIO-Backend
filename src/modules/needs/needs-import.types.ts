export interface ImportNeedRowError {
  row: number;
  message: string;
  // 'duplicate' — the row matches a Need already in this Study (or an
  // earlier row in the same file); 'validation' — anything else (missing
  // required field, etc). Lets the client tell the two apart without
  // string-matching `message`.
  type: 'duplicate' | 'validation';
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
}

export interface BulkImportNeedsPayload {
  needs: BulkImportNeedItem[];
}
