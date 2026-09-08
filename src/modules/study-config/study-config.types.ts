export interface StudyConfigOption {
  id: string;
  name: string;
  // RIO Arabic Localization — Approach 3 (Hybrid, client-confirmed
  // 2026-09-04). Null until an admin (or the initial seed import) supplies
  // it — frontend falls back to `name` when this is null.
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
}

export interface StudyConfigOptionRow {
  id: string;
  name: string;
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
}

export interface CreateStudyConfigOptionPayload {
  name: string;
  nameAr?: string;
  displayOrder?: number;
}

export interface UpdateStudyConfigOptionPayload {
  name?: string;
  nameAr?: string;
  displayOrder?: number;
}
