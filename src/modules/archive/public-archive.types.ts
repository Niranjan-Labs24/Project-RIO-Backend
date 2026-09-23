/**
 * RIO-DATA-002 — the shape sent to the open internet.
 *
 * Deliberately a different, smaller type than `ArchiveEntry`. Sharing that
 * type would mean the next field added for a signed-in operator reaches the
 * public page with it.
 */

/**
 * What the public record contains — finished work only.
 *
 * Narrower than `ArchiveEntryKind` on purpose, and the narrowing is the point:
 * the client asked on 2026-09-23 for the public page to carry released reports
 * and archived prior studies, not live studies. A live study is work in
 * progress — its needs are still being classified, scored and reviewed — and
 * publishing it would put a half-finished assessment in front of readers who
 * have no way to tell it apart from a finished one.
 *
 * `historical` covers both kinds of archived prior study: a Study flagged
 * `isHistorical`, and a HistoricalStudy upload.
 */
export type PublicArchiveKind = "report" | "historical";

/**
 * A master-data label in both languages. The English `name` doubles as the
 * filter's stable value, so switching the page to Arabic changes what is
 * shown without changing what is being filtered.
 */
export interface PublicArchiveLabel {
  name: string;
  nameAr: string | null;
}

export interface PublicArchiveEntry {
  id: string;
  kind: PublicArchiveKind;
  title: string;
  date: string;
  organizationName: string;
  regions: PublicArchiveLabel[];
  governorates: PublicArchiveLabel[];
  sector: PublicArchiveLabel | null;
  /** The subject areas the entry covers, deduplicated. An entry can span
   *  several, and one that was never classified carries none — so the page
   *  shows a dash rather than guessing. */
  domains: PublicArchiveLabel[];
}

export interface PublicArchiveSummary {
  reports: number;
  historical: number;
  organisations: number;
  earliest: string | null;
  latest: string | null;
}

/**
 * Filter options come from the master-data tables, not from whatever the
 * entries happen to contain. A reader who opens "Region" and sees two of the
 * Kingdom's thirteen regions has no way to tell whether the other eleven are
 * missing from the filter or missing from the record — so the full list is
 * offered, and an empty result says so plainly.
 */
export interface PublicArchiveFilters {
  /** All nine active domains from master data, in their configured order —
   *  not only the ones some entry happens to carry. See the note above. */
  domains: PublicArchiveLabel[];
  regions: PublicArchiveLabel[];
  years: string[];
}

export interface PublicArchiveResponse {
  summary: PublicArchiveSummary;
  entries: PublicArchiveEntry[];
  available: PublicArchiveFilters;
  generatedAt: string;
}

export interface PublicArchiveReportDetail {
  reportType: string;
  /** The report's own generated body, exactly as the platform stored it.
   *  Rendered on screen and never offered as a file: the client asked for
   *  "report opens, cannot be downloaded", so there is no storage key, no
   *  signed URL and no export route anywhere in the public module. */
  content: unknown;
}

/**
 * An archived prior study, as published.
 *
 * Carries what the entry is and what was uploaded with it — nothing the
 * platform derived from it afterwards. The client asked on 2026-09-23 for
 * these entries to show "what is in that data", meaning the uploaded document
 * itself; the needs the import produced are the platform's own working
 * records and are not part of the document a reader came to read.
 *
 * A Study flagged historical has no uploaded file of its own, so its file
 * fields are null and `hasDocument` is false.
 */
export interface PublicArchiveHistoricalDetail {
  author: string | null;
  methodologyVersionLabel: string | null;
  /** Named so a reader knows a source document exists. The storage key and
   *  file hash are deliberately absent — naming a file is not the same as
   *  handing it over, and nothing public can fetch it. */
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  /** Whether an on-page view of the upload exists to open. */
  hasDocument: boolean;
}

export interface PublicArchiveDetail {
  id: string;
  kind: PublicArchiveKind;
  title: string;
  date: string;
  organizationName: string;
  regions: PublicArchiveLabel[];
  governorates: PublicArchiveLabel[];
  sector: PublicArchiveLabel | null;
  /** Exactly one of the two is populated, matching `kind`. */
  report: PublicArchiveReportDetail | null;
  historical: PublicArchiveHistoricalDetail | null;
}

/**
 * An uploaded document, converted into page content.
 *
 * There is no `bytes`, no url and no storage key in any branch of this union,
 * and that is the whole design: the client asked for uploads to be readable
 * but not downloadable, and the only way both hold is if the file never
 * leaves the server. See PublicDocumentReaderService.
 */
export interface PublicDocumentSheet {
  name: string;
  /** Row-major cell text. The first row is treated as a header by the page. */
  rows: string[][];
  truncated: boolean;
  totalRows: number;
}

export interface PublicDocumentPage {
  number: number;
  text: string;
}

export type PublicDocumentView =
  | { type: "sheets"; sheets: PublicDocumentSheet[] }
  | { type: "pages"; pages: PublicDocumentPage[]; totalPages: number }
  | {
      type: "unavailable";
      /** `unsupported` (this file kind has no on-page view), `noTextLayer`
       *  (a scanned PDF), `empty`, or `unreadable` (it would not parse). */
      reason: "unsupported" | "noTextLayer" | "empty" | "unreadable";
      detail?: string;
    };

export interface PublicDocumentResponse {
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  view: PublicDocumentView;
}
