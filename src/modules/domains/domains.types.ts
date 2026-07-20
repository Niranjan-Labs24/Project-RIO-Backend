export interface DomainRow {
  id: string;
  code: string;
  name: string;
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
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Domain {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

export interface SubDomain {
  id: string;
  domainId: string;
  code: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

/** A domain with its sub-domains nested — one round trip instead of the
 * N+1 pattern of listing domains then fetching each one's sub-domains
 * separately (see DomainsService.listDomainsWithSubDomains). */
export interface DomainWithSubDomains extends Domain {
  subDomains: SubDomain[];
}

export interface CreateDomainPayload {
  code: string;
  name: string;
  displayOrder?: number;
}

export interface UpdateDomainPayload {
  code?: string;
  name?: string;
  displayOrder?: number;
}

export interface CreateSubDomainPayload {
  code: string;
  name: string;
  displayOrder?: number;
}

export interface UpdateSubDomainPayload {
  code?: string;
  name?: string;
  displayOrder?: number;
}
