/**
 * Builds the three boundary files the geographic dashboard's filled map draws:
 *
 *   public/sa-regions.geojson        13 regions, keyed by ISO code
 *   public/sa-governorates.geojson   150 governorates, keyed by code
 *   public/sa-centers.geojson        1,404 centres, keyed by code
 *
 *   node scripts/build-map-boundaries.mjs
 *
 * Run offline and committed, so the app carries no geometry dependency and the
 * browser just fetches finished polygons.
 *
 * Regions and governorates are real boundaries (geoBoundaries ADM1/ADM2).
 * CENTRES ARE NOT. No public dataset publishes centre boundaries for Saudi
 * Arabia — the platform holds a single coordinate per centre. Each centre cell
 * here is the area *closest to that centre* within its governorate (a Voronoi
 * cell clipped to the governorate outline), which is an approximation and is
 * labelled as one in the UI. It is used instead of a circle because circles
 * overlap each other and leave gaps, so they cannot tile a governorate; Voronoi
 * cells cover it exactly once with no gaps and no overlap.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const GEO = resolve('prisma/data/.geoboundaries');
const OUT = resolve('../Project-RIO-Frontend/public');
const TOLERANCE = 0.008; // degrees, ~900m — below one pixel at the map's max zoom
const MIN_RING = 6;

// ── geometry ────────────────────────────────────────────────────────────────

const perp = (p, a, b) => {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  if (!dx && !dy) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const c = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + c * dx), y - (y1 + c * dy));
};

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perp(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

const round = (ring) => ring.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);

function cleanRing(r, tol = TOLERANCE) {
  let out = round(simplify(r, tol));
  const [fx, fy] = out[0], [lx, ly] = out[out.length - 1];
  if (fx !== lx || fy !== ly) out.push([fx, fy]);
  return out;
}

/** Sutherland–Hodgman clip of a polygon ring by one half-plane.
 *  `keep(p)` is true for points on the side being kept; `cut` returns the
 *  crossing point of the segment with the boundary line. */
function clipHalfPlane(ring, keep, cut) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const cur = ring[i], prev = ring[(i + ring.length - 1) % ring.length];
    const kc = keep(cur), kp = keep(prev);
    if (kc) {
      if (!kp) out.push(cut(prev, cur));
      out.push(cur);
    } else if (kp) {
      out.push(cut(prev, cur));
    }
  }
  return out;
}

/** The Voronoi cell of `p` among `others`, clipped to `boundary`.
 *  Each other point contributes one half-plane: the side of the perpendicular
 *  bisector nearer to `p`. Intersecting them all leaves exactly the area for
 *  which `p` is the closest centre. */
function voronoiCell(p, others, boundary) {
  let cell = boundary;
  for (const q of others) {
    if (cell.length < 3) return [];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    if (!dx && !dy) continue;
    // Points nearer p satisfy: dx*x + dy*y < c, with c at the midpoint.
    const c = (dx * (p[0] + q[0]) + dy * (p[1] + q[1])) / 2;
    const side = (pt) => dx * pt[0] + dy * pt[1] - c;
    cell = clipHalfPlane(
      cell,
      (pt) => side(pt) <= 0,
      (a, b) => {
        const sa = side(a), sb = side(b), t = sa / (sa - sb);
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      },
    );
  }
  return cell;
}

/** Largest outer ring of a Polygon/MultiPolygon, by vertex count. */
function outerRing(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null;
  for (const poly of polys) if (!best || poly[0].length > best.length) best = poly[0];
  return best;
}

const bbox = (ring) => ring.reduce(
  (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity],
);

const inBbox = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

// ── build ───────────────────────────────────────────────────────────────────

const feature = (props, polys) => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'MultiPolygon', coordinates: polys },
});

function multi(geom, tol = TOLERANCE) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys
    .map((poly) => poly.map((r) => cleanRing(r, tol)).filter((r) => r.length >= MIN_RING))
    .filter((poly) => poly.length > 0);
}

const client = new pg.Client({
  connectionString: process.env.SUPERVISOR_DATABASE_URL ?? process.env.DATABASE_URL,
});
await client.connect();

// 1 ── regions, joined on ISO code (exact, no name matching needed)
const adm1 = JSON.parse(readFileSync(`${GEO}/sau-adm1.geojson`, 'utf8'));
const regions = (await client.query('SELECT code, iso_code, name, name_ar FROM regions')).rows;
const regionByIso = new Map(regions.map((r) => [r.iso_code, r]));

const regionFeatures = [];
for (const f of adm1.features) {
  const r = regionByIso.get(f.properties.shapeISO);
  if (!r) { console.warn('  region polygon with no DB match:', f.properties.shapeName); continue; }
  // Keyed on the numeric code, not the ISO code, because that is what the map
  // API returns as a region point's `code` (String(region.code)). The ISO code
  // is what joins us to geoBoundaries; it is kept as a property for tracing a
  // shape back to its source, but it is not the join key for the client.
  regionFeatures.push(
    feature({ key: String(r.code), iso: r.iso_code, name: r.name, nameAr: r.name_ar }, multi(f.geometry)),
  );
}
writeFileSync(`${OUT}/sa-regions.geojson`, JSON.stringify({ type: 'FeatureCollection', features: regionFeatures }));
console.log(`regions      : ${regionFeatures.length}/${regions.length}`);

// 2 ── governorates, joined on name via the reviewed mapping file
const adm2 = JSON.parse(readFileSync(`${GEO}/sau-adm2.geojson`, 'utf8'));
const override = JSON.parse(readFileSync('prisma/data/governorate-boundary-map.json', 'utf8')).map;
const govs = (await client.query('SELECT code, name, name_ar FROM governorates')).rows;

const norm = (s) => s.toLowerCase()
  .replace(/\b(governorate|province|region|municipality|amanah)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '')
  .replace(/^al/, '');

const adm2ByName = new Map();
for (const f of adm2.features) {
  adm2ByName.set(f.properties.shapeName, f);
  if (!adm2ByName.has(norm(f.properties.shapeName))) adm2ByName.set(norm(f.properties.shapeName), f);
}

const govFeatures = [];
const govShape = new Map(); // code -> outer ring, for clipping centre cells
let govMissing = 0;
for (const g of govs) {
  const explicit = Object.prototype.hasOwnProperty.call(override, g.code) ? override[g.code] : undefined;
  const f = explicit === null ? null : adm2ByName.get(explicit ?? '') ?? adm2ByName.get(norm(g.name));
  if (!f) { govMissing++; continue; }
  govFeatures.push(feature({ key: g.code, name: g.name, nameAr: g.name_ar }, multi(f.geometry)));
  govShape.set(g.code, outerRing(f.geometry));
}
writeFileSync(`${OUT}/sa-governorates.geojson`, JSON.stringify({ type: 'FeatureCollection', features: govFeatures }));
console.log(`governorates : ${govFeatures.length}/${govs.length}  (${govMissing} without a polygon)`);

// 3 ── centres, as Voronoi cells clipped to their governorate
const centers = (await client.query(
  `SELECT c.code, c.name, c.name_ar, c.latitude, c.longitude, g.code AS gov_code
   FROM centers c JOIN governorates g ON g.id = c.governorate_id
   WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL`,
)).rows;

const byGov = new Map();
for (const c of centers) {
  if (!byGov.has(c.gov_code)) byGov.set(c.gov_code, []);
  byGov.get(c.gov_code).push(c);
}

const centerFeatures = [];
let noGovShape = 0, outside = 0;
for (const [govCode, list] of byGov) {
  const boundary = govShape.get(govCode);
  if (!boundary) { noGovShape += list.length; continue; }
  const box = bbox(boundary);
  const pts = list.map((c) => [Number(c.longitude), Number(c.latitude)]);
  for (let i = 0; i < list.length; i++) {
    // A coordinate outside its own governorate would produce a cell on the
    // wrong side of the boundary, so it is dropped rather than drawn wrong.
    if (!inBbox(pts[i], box)) { outside++; continue; }
    const cell = voronoiCell(pts[i], pts.filter((_, j) => j !== i), boundary);
    if (cell.length < 3) continue;
    const ring = cleanRing(cell, TOLERANCE / 2);
    if (ring.length < 4) continue;
    const c = list[i];
    centerFeatures.push(
      feature({ key: c.code, name: c.name, nameAr: c.name_ar, approximate: true }, [[ring]]),
    );
  }
}
writeFileSync(`${OUT}/sa-centers.geojson`, JSON.stringify({ type: 'FeatureCollection', features: centerFeatures }));
console.log(`centres      : ${centerFeatures.length}/${centers.length}  (${noGovShape} in a governorate with no polygon, ${outside} outside their governorate)`);

await client.end();

const kb = (p) => `${(readFileSync(p).length / 1024).toFixed(0)} KB`;
console.log(`\nsizes: regions ${kb(`${OUT}/sa-regions.geojson`)}, governorates ${kb(`${OUT}/sa-governorates.geojson`)}, centres ${kb(`${OUT}/sa-centers.geojson`)}`);
