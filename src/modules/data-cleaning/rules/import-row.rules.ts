// RIO-FR-002 — rules for a spreadsheet row that never became a Need.
//
// The import already rejects rows for missing title/statement and for
// duplicates, and reports them back to the uploader in the HTTP response. That
// response is gone the moment the page is closed. Q14 asks for "a report per
// source showing what was flagged", which means those rejections have to
// survive as rows, not just as a toast.
//
// The duplicate case is the one that changes behaviour: today the import
// REJECTS a duplicate row outright, which Q11 forbids — duplicates are
// proposed, never acted on automatically. Turning the rejection into a flag is
// what makes the import's behaviour match the acceptance criterion. The row is
// still not imported (that is the uploader's own file to fix), but the
// decision is now recorded and reviewable instead of vanishing.

import type { PendingFlag, RejectedImportRow } from "../data-cleaning.types";

export function evaluateImportRows(rows: RejectedImportRow[]): PendingFlag[] {
  return rows.map((row) => {
    const isDuplicate = row.kind === "duplicate";
    return {
      entityType: "import_row" as const,
      entityId: null,
      rowNumber: row.rowNumber,
      field: row.field,
      ruleCode: isDuplicate ? "IMPORT_DUPLICATE_ROW" : "IMPORT_ROW_REJECTED",
      // A duplicate row HAS a value; a rejected row is missing one. The
      // severity follows the actual defect, and the
      // cleaning_flags_missing_has_no_proposal CHECK holds either way because
      // neither case proposes anything.
      severity: isDuplicate ? "out_of_vocabulary" : "missing",
      originalValue: isDuplicate ? row.originalValue : null,
      proposedValue: null,
      confidence: null,
      detail: { field: row.field, message: row.message, kind: row.kind },
    } satisfies PendingFlag;
  });
}
