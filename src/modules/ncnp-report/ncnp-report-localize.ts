import type { NcnpNamedBreakdown, NcnpReport } from './ncnp-report.types';

/** name -> Arabic name, per kind of master data. Built by the service from the
 *  same tables the in-app viewer resolves against (Domain/SubDomain/Region/
 *  Governorate/Center `nameAr`, GapTypeOption `nameAr`). */
export interface NcnpArabicNames {
  domains: Map<string, string>;
  subDomains: Map<string, string>;
  geography: Map<string, string>;
  gapTypes: Map<string, string>;
}

/**
 * Returns a copy of the report with master-data names swapped for their
 * Arabic ones, for the Arabic PDF/Excel export. The live payload is not
 * backend-localized (the in-app viewer does this lookup client-side), so an
 * export has to do the same — otherwise "Water & Sanitation" stays English in
 * an otherwise Arabic document. Names with no Arabic value pass through
 * unchanged; user-typed text (need titles, organization names) is not master
 * data and is left as recorded.
 */
export function localizeNcnpReportNames(report: NcnpReport, ar: NcnpArabicNames): NcnpReport {
  const d = (n: string) => ar.domains.get(n) ?? n;
  const sd = (n: string) => ar.subDomains.get(n) ?? n;
  const g = (n: string) => ar.geography.get(n) ?? n;
  const gap = (n: string | null) => (n ? (ar.gapTypes.get(n) ?? ar.domains.get(n) ?? n) : n);
  const geo = (rows: NcnpNamedBreakdown[]) => rows.map((r) => ({ ...r, name: g(r.name) }));
  return {
    ...report,
    needDomains: report.needDomains.map((r) => ({ ...r, domainName: d(r.domainName) })),
    needSubDomains: report.needSubDomains.map((r) => ({ ...r, domainName: d(r.domainName), subDomainName: sd(r.subDomainName) })),
    needsGeography: {
      byRegion: geo(report.needsGeography.byRegion),
      byGovernorate: geo(report.needsGeography.byGovernorate),
      byCenter: geo(report.needsGeography.byCenter),
    },
    geography: {
      organizationsByRegion: geo(report.geography.organizationsByRegion),
      organizationsByGovernorate: geo(report.geography.organizationsByGovernorate),
      organizationsByCenter: geo(report.geography.organizationsByCenter),
      studiesByRegion: geo(report.geography.studiesByRegion),
    },
    surveyGeography: {
      byRegion: geo(report.surveyGeography.byRegion),
      byGovernorate: geo(report.surveyGeography.byGovernorate),
      byCenter: geo(report.surveyGeography.byCenter),
    },
    surveyAnalytics: {
      ...report.surveyAnalytics,
      statusByRegion: report.surveyAnalytics.statusByRegion.map((r) => ({ ...r, regionName: g(r.regionName) })),
    },
    regionSummary: report.regionSummary.map((r) => ({ ...r, regionName: g(r.regionName) })),
    responseAnalytics: {
      ...report.responseAnalytics,
      responsesByRegion: report.responseAnalytics.responsesByRegion.map((r) => ({ ...r, regionName: g(r.regionName) })),
    },
    priorityOverview: {
      ...report.priorityOverview,
      domainComparison: report.priorityOverview.domainComparison.map((r) => ({ ...r, domainName: d(r.domainName) })),
    },
    criticalNeeds: {
      ...report.criticalNeeds,
      topCriticalNeeds: report.criticalNeeds.topCriticalNeeds.map((n) => ({ ...n, domain: n.domain ? d(n.domain) : n.domain, subDomain: n.subDomain ? sd(n.subDomain) : n.subDomain, primaryGap: gap(n.primaryGap), unitGeoRegion: n.unitGeoRegion ? g(n.unitGeoRegion) : n.unitGeoRegion })),
      priorityNeeds: report.criticalNeeds.priorityNeeds.map((n) => ({ ...n, domain: n.domain ? d(n.domain) : n.domain, subDomain: n.subDomain ? sd(n.subDomain) : n.subDomain, primaryGap: gap(n.primaryGap), unitGeoRegion: n.unitGeoRegion ? g(n.unitGeoRegion) : n.unitGeoRegion })),
    },
    domainRegionIntersections: report.domainRegionIntersections.map((r) => ({ ...r, regionName: g(r.regionName), domainName: d(r.domainName) })),
  };
}

const FREE_TEXT_KEYS = new Set(['organizationName', 'needTitle', 'indicatorId']);

/**
 * Returns a deep copy with every user-typed string (organization names, need
 * titles, indicators) replaced by `fn(value)`. `fn` receives the field key so
 * organization names can be rendered bilingually while other text is just
 * translated.
 */
export async function mapNcnpFreeText<T>(report: T, fn: (text: string, key: string) => Promise<string>): Promise<T> {
  const found = new Map<string, Set<string>>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FREE_TEXT_KEYS.has(k) && typeof v === 'string' && v.trim()) {
          if (!found.has(k)) found.set(k, new Set());
          found.get(k)!.add(v);
        } else walk(v);
      }
    }
  };
  walk(report);
  const resolved = new Map<string, string>();
  const jobs: Array<[string, string]> = [];
  for (const [k, set] of found) for (const v of set) jobs.push([k, v]);
  const CONCURRENCY = 6;
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    await Promise.all(
      jobs.slice(i, i + CONCURRENCY).map(async ([k, v]) => {
        try {
          resolved.set(`${k}\u0000${v}`, await fn(v, k));
        } catch {
          resolved.set(`${k}\u0000${v}`, v);
        }
      }),
    );
  }
  const rebuild = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rebuild);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [
          k,
          FREE_TEXT_KEYS.has(k) && typeof v === 'string' && resolved.has(`${k}\u0000${v}`) ? resolved.get(`${k}\u0000${v}`) : rebuild(v),
        ]),
      );
    }
    return node;
  };
  return rebuild(report) as T;
}
