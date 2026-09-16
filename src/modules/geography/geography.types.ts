export interface RegionRow {
  id: string;
  code: number;
  name: string;
  // RIO Arabic Localization — Approach 3 (Hybrid, client-confirmed
  // 2026-09-04). Sourced from the client-supplied
  // KSA_Geographic_Reference_ENRICHED workbook (see
  // prisma/import-arabic-geography.ts) — a real official name, not a
  // machine translation. Null only if a future re-import ever adds a row
  // this workbook doesn't cover.
  nameAr: string | null;
  isoCode: string;
  capital: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GovernorateRow {
  id: string;
  code: string;
  regionId: string;
  name: string;
  nameAr: string | null;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CenterRow {
  id: string;
  code: string;
  governorateId: string;
  name: string;
  nameAr: string | null;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Region {
  id: string;
  code: number;
  name: string;
  nameAr: string | null;
  isoCode: string;
  capital: string;
}

export interface Governorate {
  id: string;
  code: string;
  regionId: string;
  name: string;
  nameAr: string | null;
  category: string;
}

export interface Center {
  id: string;
  code: string;
  governorateId: string;
  name: string;
  nameAr: string | null;
  category: string;
}
