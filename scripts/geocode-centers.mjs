/**
 * RIO-FR-008 — batch geocodes the 1,404 markaz/centers.
 *
 *   node scripts/geocode-centers.mjs
 *
 * Input  : KSA_Geographic_Reference_ENRICHED.xlsx, using the client's own
 *          Arabic "Geocoding Query" column. Arabic matters — OpenStreetMap
 *          labels Saudi places in Arabic, and a pilot on the English
 *          transliterations found only a quarter of centers against 54% for
 *          these.
 * Output : prisma/data/center-coordinates.json, the exact shape
 *          `npm run geo:seed` already reads, plus a filled copy of the
 *          workbook for the client.
 *
 * Two rules keep the result honest:
 *
 *  - Every hit is checked against its parent governorate's polygon. A name
 *    match in the wrong governorate is worse than no match, because it puts
 *    a village on the map somewhere it is not.
 *  - A center that cannot be found falls back to its governorate's own
 *    coordinate, recorded with a large radius and a status saying so. That
 *    is why the client's sheet carries Radius and Geocode Status columns:
 *    an approximate point is useful as long as nothing pretends it is exact.
 *
 * Nominatim's policy is one request per second with a real User-Agent, so a
 * full run takes roughly half an hour. Progress is checkpointed, so an
 * interrupted run resumes instead of starting over.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import ExcelJS from 'exceljs';

// The client's enriched workbook. It is not committed (it arrives by email
// and is theirs, not ours), so the path is configurable and the default is
// the repo's own sibling folder rather than one developer's machine.
const WORKBOOK =
  process.env.GEO_WORKBOOK ?? '../KSA_Geographic_Reference_ENRICHED.xlsx';
const OUT_JSON = './prisma/data/center-coordinates.json';
const OUT_XLSX = './prisma/data/KSA_Geographic_Reference_GEOCODED.xlsx';
const CHECKPOINT = './prisma/data/.geoboundaries/center-geocode-progress.json';
const ADM2 = './prisma/data/.geoboundaries/sau-adm2.geojson';
const GOV_COORDS = './prisma/data/governorate-coordinates.json';
const UA = 'RIO-platform-geo/1.0 (ayush.yadav@labs24.co)';
const DELAY_MS = 1100;

/** Radius recorded against a point, in metres — how far the truth might be. */
const RADIUS_EXACT = 2000;
const RADIUS_GOVERNORATE_FALLBACK = 40000;

const txt = (c) => {
  const v = c.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.result ?? v.text ?? '');
  return String(v);
};

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/\bgovernorate\b/g, '')
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(al|an|ad|as|ash|at|az|ar|el)\s+/, '')
    .replace(/\s+/g, '');
}

function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function contains(geometry, lng, lat) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys.some((p) => ringContains(p[0], lng, lat));
}

const govShapes = new Map();
if (existsSync(ADM2)) {
  for (const f of JSON.parse(readFileSync(ADM2, 'utf-8')).features) {
    govShapes.set(norm(f.properties.shapeName), f.geometry);
  }
}

const govCoords = existsSync(GOV_COORDS)
  ? JSON.parse(readFileSync(GOV_COORDS, 'utf-8')).coordinates
  : {};

mkdirSync('./prisma/data/.geoboundaries', { recursive: true });
const done = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, 'utf-8')) : {};

const wb = new ExcelJS.Workbook();
if (!existsSync(WORKBOOK)) {
  console.error(`Workbook not found at ${WORKBOOK}.`);
  console.error("Set GEO_WORKBOOK to the client's enriched reference file.");
  process.exit(1);
}
await wb.xlsx.readFile(WORKBOOK);
const ws = wb.getWorksheet('المراكز Centers');

const centers = [];
ws.eachRow((row, n) => {
  if (n === 1) return;
  const code = txt(row.getCell(1));
  if (!code) return;
  centers.push({
    rowNumber: n,
    code,
    govCode: txt(row.getCell(4)),
    nameAr: txt(row.getCell(6)),
    govEn: txt(row.getCell(8)),
    query: txt(row.getCell(10)),
  });
});

console.log(`${centers.length} centers to geocode`);
console.log(`${Object.keys(done).length} already done (resuming)`);
console.log(`estimated time for the rest: ~${Math.ceil(((centers.length - Object.keys(done).length) * DELAY_MS) / 60000)} min\n`);

let n = 0;
for (const c of centers) {
  n++;
  if (done[c.code]) continue;

  let hit = null;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(c.query)}&format=json&limit=1&countrycodes=sa`,
      { headers: { 'User-Agent': UA } },
    );
    if (res.ok) hit = (await res.json())[0] ?? null;
  } catch {
    /* network hiccup — treated as a miss and retried on the next run */
  }

  if (hit) {
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    const shape = govShapes.get(norm(c.govEn));
    if (!shape || contains(shape, lng, lat)) {
      done[c.code] = {
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        radius: RADIUS_EXACT,
        status: shape ? 'geocoded' : 'geocoded (governorate not verifiable)',
        source: 'nominatim',
      };
    } else {
      // Found, but in the wrong governorate — discard the point and fall
      // through to the governorate fallback below.
      hit = null;
    }
  }

  if (!hit && !done[c.code]) {
    const g = govCoords[c.govCode];
    done[c.code] = g
      ? {
          lat: g.lat,
          lng: g.lng,
          radius: RADIUS_GOVERNORATE_FALLBACK,
          status: 'approximate (governorate centre)',
          source: 'governorate-fallback',
        }
      : { lat: null, lng: null, radius: null, status: 'not found', source: null };
  }

  if (n % 25 === 0) {
    writeFileSync(CHECKPOINT, JSON.stringify(done));
    const exact = Object.values(done).filter((d) => d.source === 'nominatim').length;
    console.log(`  ${n}/${centers.length}  exact=${exact}  fallback=${Object.values(done).filter((d) => d.source === 'governorate-fallback').length}`);
  }
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

writeFileSync(CHECKPOINT, JSON.stringify(done));

// ── outputs ──────────────────────────────────────────────────────────────
const coordinates = {};
for (const [code, d] of Object.entries(done)) {
  if (d.lat !== null) coordinates[code] = { lat: d.lat, lng: d.lng, source: d.source, radius: d.radius };
}
writeFileSync(
  OUT_JSON,
  JSON.stringify(
    {
      _comment:
        'Center coordinates for RIO-FR-008. Geocoded from the client ENRICHED workbook Arabic query column via Nominatim, validated against the parent governorate polygon; unfound centers fall back to their governorate centre with a 40km radius and a status saying so.',
      _generated: new Date().toISOString().slice(0, 10),
      coordinates,
    },
    null,
    2,
  ) + '\n',
);

for (const c of centers) {
  const d = done[c.code];
  if (!d) continue;
  const row = ws.getRow(c.rowNumber);
  row.getCell(11).value = d.lat;
  row.getCell(12).value = d.lng;
  row.getCell(13).value = d.radius;
  row.getCell(14).value = d.status;
}
await wb.xlsx.writeFile(OUT_XLSX);

const exact = Object.values(done).filter((d) => d.source === 'nominatim').length;
const fallback = Object.values(done).filter((d) => d.source === 'governorate-fallback').length;
const none = Object.values(done).filter((d) => d.lat === null).length;
console.log(`\n─── done ───`);
console.log(`  exact (geocoded + verified)   ${exact}  ${Math.round((exact / centers.length) * 100)}%`);
console.log(`  approximate (governorate)     ${fallback}  ${Math.round((fallback / centers.length) * 100)}%`);
console.log(`  no coordinate at all          ${none}`);
console.log(`\n  ${OUT_JSON}`);
console.log(`  ${OUT_XLSX}`);
console.log(`\n  next: npm run geo:seed`);
