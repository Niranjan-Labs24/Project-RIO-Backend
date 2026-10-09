/**
 * The public dashboard on the landing page (/home#dashboard) — the same needs
 * the NCNP Geographic Dashboard reads, reduced to averages per place and
 * domain, for anyone to see without logging in.
 *
 * Totals only. No need text, no organisation, no village, no user, no study:
 * a reader learns how severe a domain is in a governorate, not whose need it
 * is or what it says.
 */

export interface PublicDashboardDomain {
  code: string;
  name: string;
  nameAr: string | null;
}

/** One domain's figure at one place. */
export interface PublicDashboardDomainScore {
  code: string;
  /** Average priority score of the counted needs, 0–100. */
  score: number;
  needCount: number;
}

/** A region or governorate that has at least one counted need. */
export interface PublicDashboardArea {
  code: string;
  name: string;
  nameAr: string | null;
  /** Average priority score across every counted need here, 0–100. */
  score: number;
  needCount: number;
  /** Only domains with at least one counted need; a missing domain means
   *  "nothing approved here yet", not "low". */
  domains: PublicDashboardDomainScore[];
}

export interface PublicDashboardGovernorate extends PublicDashboardArea {
  regionCode: number;
}

export interface PublicDashboardRegion extends PublicDashboardArea {
  regionCode: number;
}

export interface PublicDashboardResponse {
  /** The active domains, in their configured order — the table's rows. */
  domains: PublicDashboardDomain[];
  regions: PublicDashboardRegion[];
  governorates: PublicDashboardGovernorate[];
  totals: { needs: number; regions: number; governorates: number };
  generatedAt: string;
}
