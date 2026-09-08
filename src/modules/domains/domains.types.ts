export interface DomainRow {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubDomainRow {
  id: string;
  domainId: string;
  code: string;
  name: string;
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Domain {
  id: string;
  code: string;
  name: string;
  // RIO Arabic Localization — Approach 3 (Hybrid, client-confirmed
  // 2026-09-04). Null until the client supplies Arabic Domain/Sub-domain
  // names and an admin enters them — frontend falls back to `name`.
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
}

export interface SubDomain {
  id: string;
  domainId: string;
  code: string;
  name: string;
  nameAr: string | null;
  displayOrder: number;
  isActive: boolean;
}

/** A domain with its sub-domains nested — one round trip instead of the
 * N+1 pattern of listing domains then fetching each one's sub-domains
 * separately (see DomainsService.listDomainsWithSubDomains). */
export interface DomainWithSubDomains extends Domain {
  subDomains: SubDomain[];
}

/** Just enough to populate a sector dropdown — reachable pre-login (signup
 * form), so deliberately excludes `code`/`displayOrder`, which nobody
 * outside Methodology Configuration needs to see. */
export interface PublicDomainOption {
  name: string;
  // RIO Arabic Localization (Approach 3, Hybrid) — the pre-login signup
  // form's sector dropdown needs this the same as every authenticated Domain
  // read does; it was omitted here (a `select: { name: true }` predates the
  // Arabic work) and stayed in English on Sign Up even with Arabic selected.
  nameAr: string | null;
}

export interface CreateDomainPayload {
  code: string;
  name: string;
  nameAr?: string;
  displayOrder?: number;
}

export interface UpdateDomainPayload {
  code?: string;
  name?: string;
  nameAr?: string;
  displayOrder?: number;
}

export interface CreateSubDomainPayload {
  code: string;
  name: string;
  nameAr?: string;
  displayOrder?: number;
}

export interface UpdateSubDomainPayload {
  code?: string;
  name?: string;
  nameAr?: string;
  displayOrder?: number;
}
