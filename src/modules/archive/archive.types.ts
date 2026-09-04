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
}
