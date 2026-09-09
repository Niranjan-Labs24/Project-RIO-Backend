/**
 * RIO-FR-008 — Geographic Dashboard.
 *
 * The level is a parameter rather than a hard-coded choice. The BRD asks for
 * villages, but villages are free text in this system with no coordinates
 * anywhere, so the dashboard ships at governorate level — the finest grain
 * we can actually place on a map today. Center is already wired end to end
 * and turns on the moment `centers.latitude` is populated.
 */
export const GEO_LEVELS = ['region', 'governorate', 'center'] as const;
export type GeoLevel = (typeof GEO_LEVELS)[number];

/** Priority bands, ordered worst-first — the order the legend renders in. */
export const PRIORITY_BANDS = ['critical', 'high', 'medium', 'low'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export interface GeoMapFilters {
  /** Study.targetSector. */
  sector?: string;
  /** Need.urgency. */
  urgency?: string;
  /** Need.status. */
  status?: string;
  /** Only needs from studies of this kind. Lets the map show the imported
   *  prior study (RIO-DATA-002) on its own, or exclude it. */
  historical?: 'only' | 'exclude';
}

/** Just enough of an Initiative to name it and link to it. */
export interface GeoMapInitiative {
  id: string;
  name: string;
  status: string;
  domain: string | null;
}

/** Keeps a busy place from dominating the response; the count stays exact. */
export const MAX_INITIATIVES_PER_POINT = 8;

/** One organisation's footprint at a place — the NCNP view lists these. */
export interface GeoMapOrgSummary {
  name: string;
  studyCount: number;
}

export interface GeoMapPoint {
  id: string;
  code: string;
  name: string;
  regionName: string;
  latitude: number;
  longitude: number;
  /** Needs matching the current filters at this place. Drives marker size. */
  needCount: number;
  /** The worst band present here — what the marker is coloured by. Null when
   *  none of the needs have been scored yet, which is visually distinct from
   *  "scored and low". */
  priorityBand: PriorityBand | null;
  /** Full breakdown, so the tooltip can explain the colour. */
  priorityCounts: Record<PriorityBand | 'unscored', number>;
  /** RIO-FR-009 — initiatives linked to needs at this place. The count
   *  alone answers "is anything being done here"; the list is what lets the
   *  client actually link through to them, which is what the acceptance
   *  criterion asks for. Capped so one busy governorate cannot bloat the
   *  whole map payload. */
  initiativeCount: number;
  initiatives: GeoMapInitiative[];
  /** Most common sector among this place's needs, for the sector highlight. */
  topSector: string | null;
  /** How far the true location might be from this point, in metres.
   *  1,022 of our 1,404 centers were geocoded from their own name and sit
   *  within ~2km; the remaining 365 fall back to their governorate's centre
   *  and can be over 100km out. */
  accuracyM: number | null;
  /** True for a fallback point. The client must draw these differently —
   *  an estimate that looks identical to a surveyed location is how someone
   *  ends up funding the wrong village. */
  isApproximate: boolean;

  // ── the study/organisation view this dashboard also carries ──────────
  // Folded in so one endpoint answers both questions the Geographic
  // Dashboard asks — "where are the needs" and "who is working there".
  // Previously the client fetched studies, then one request per study to
  // get its needs, which is an N+1 that grew with the data.
  studyCount: number;
  /** Distinct organisations with a study at this place. Only meaningful to
   *  a cross-entity viewer; an org sees only itself. */
  orgCount: number;
  /** Needs here that have cleared review. */
  publishedCount: number;
  /** Most common need domain at this place. */
  leadingDomain: string | null;
  /** Organisations working here, biggest first. Capped like initiatives. */
  workingOrgs: GeoMapOrgSummary[];
  /** Free-text village names recorded on this place's needs. */
  villages: string[];
}

export interface GeoMapResponse {
  level: GeoLevel;
  points: GeoMapPoint[];
  /** What the map is NOT showing, stated plainly. A dashboard that silently
   *  drops 80% of the data is worse than one that admits it. */
  coverage: {
    needsTotal: number;
    needsPlotted: number;
    needsWithoutLocation: number;
    placesWithoutCoordinates: number;
  };
  /** Filter values actually present in the data, so the client never offers
   *  an option that returns nothing. */
  available: {
    sectors: string[];
    urgencies: string[];
    statuses: string[];
  };
}
