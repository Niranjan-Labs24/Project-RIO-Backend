export interface ImportNeedRowError {
  row: number;
  message: string;
}

export interface ImportNeedsResult {
  totalRows: number;
  imported: number;
  failed: number;
  errors: ImportNeedRowError[];
}
