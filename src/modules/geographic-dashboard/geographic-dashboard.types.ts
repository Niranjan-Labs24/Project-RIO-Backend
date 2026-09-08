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
  /** RIO-FR-009 — initiatives linked to needs at this place. */
  initiativeCount: number;
  /** Most common sector among this place's needs, for the sector highlight. */
  topSector: string | null;
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
