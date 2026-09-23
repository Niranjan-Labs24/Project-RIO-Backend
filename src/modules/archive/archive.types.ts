// "historical" — RIO-FR-013 (client Q25) — a study conducted before the
// platform existed, uploaded as a reference document rather than built up
// through Study/Need/Survey.
export type ArchiveEntryKind = "study" | "report" | "historical";

export interface ArchiveEntry {
  id: string;
  kind: ArchiveEntryKind;
  title: string;
  status: string;
  date: string;
  studyId: string | null;
  organizationId: string;
  organizationName: string;
  region: string[];
  sector: string | null;
  villages: string[];
  /** The subject areas this entry's Needs were classified into. Backs the
   *  Domain filter, which the client asked on 2026-09-23 to offer every
   *  domain in master data rather than the handful the loaded rows happen
   *  to mention. Empty where nothing has been classified yet. */
  domains: { name: string; nameAr: string | null }[];
  // Structured geography, now filled for all three kinds. It used to be
  // historical-only, and the table's "Governorates" column fell back to
  // `villages` for the other two — so a Study row showed village names
  // under a Governorates heading and the Governorate filter could never
  // match it. Study/Report now resolve their own StudyGovernorate rows
  // (client, 2026-09-23: "show all region and governorate, not only few").
  governorateNames?: string[];
  centerNames?: string[];
  author?: string;
  methodologyVersionLabel?: string;
  uploadedByName?: string | null;
  uploadedAt?: string;
  /** RIO-DATA-002 — the archived file's name, set only for `historical`
   * entries. The client needs the extension to know whether the entry can
   * be imported into the dashboard at all: only one-need-per-row formats
   * (.csv/.xlsx/.xls) can, so a PDF upload must not be offered the action. */
  fileName?: string | null;
}

export interface ListArchiveParams {
  kind?: ArchiveEntryKind;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Owning organisation — only meaningful for crossEntity roles browsing
   * every org's archive; non-crossEntity callers are always scoped to
   * their own org regardless of this filter. */
  organizationId?: string;
  region?: string;
  sector?: string;
  village?: string;
  /** Matches against `domains`. Separate from `sector`, which is the
   *  Study's own Target Sector — a different field with its own list. */
  domain?: string;
  /** Matches against `governorateNames`. `village` still matches the free
   *  text village list, which is a different thing and kept working. */
  governorate?: string;
}
