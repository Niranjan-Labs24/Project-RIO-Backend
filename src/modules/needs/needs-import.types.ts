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
