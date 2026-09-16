/**
 * RIO-FR-008 — second pass: rescues the centers Nominatim could not find.
 *
 *   node scripts/geocode-centers-overpass.mjs
 *
 * Run this AFTER geocode-centers.mjs. It only touches rows that pass left
 * approximate, and it asks a different question.
 *
 * Nominatim answers "where is X?" and gives up when a small village is not
 * indexed as a searchable place. Overpass answers "what is inside this box?"
 * — so this pulls every named settlement in a governorate in one query and
 * matches Arabic names locally. On a pilot that recovered 68% of Nominatim's
 * misses, taking overall exact coverage from ~50% to ~84%.
 *
 * One query per governorate (~150), not per center, so the rate limit is the
 * binding constraint rather than the volume. Overpass answers 429 when
 * pushed, so the delay is generous and a 429 is retried rather than skipped.
 *
 * Also recomputes the fallback radius per governorate instead of a flat
 * 40km: Riyadh and a small coastal governorate are not equally uncertain.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ExcelJS from 'exceljs';

// The client's enriched workbook. It is not committed (it arrives by email
// and is theirs, not ours), so the path is configurable and the default is
// the repo's own sibling folder rather than one developer's machine.
const WORKBOOK =
  process.env.GEO_WORKBOOK ?? '../KSA_Geographic_Reference_ENRICHED.xlsx';
const CHECKPOINT = './prisma/data/.geoboundaries/center-geocode-progress.json';
const ADM2 = './prisma/data/.geoboundaries/sau-adm2.geojson';
const UA = 'RIO-platform-geo/1.0 (ayush.yadav@labs24.co)';
const DELAY_MS = 12_000;
const RADIUS_EXACT = 2000;

const txt = (c) => {
  const v = c.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return String(v.result ?? v.text ?? '');
  return String(v);
};

/** Arabic normalisation — strips the definite article, unifies alef/ya/
 *  ta-marbuta and drops diacritics, so "عرقه" and "العرقة" compare equal. */
function normAr(s) {
  return String(s)
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, '')
    .replace(/^ال/, '')
    .trim();
}

function normEn(s) {
  return String(s)
    .toLowerCase()
    .replace(/\bgovernorate\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^(al|an|ad|as|ash|at|az|ar|el)/, '');
}
const phonetic = (k) =>
  k.replace(/dh|th/g, 'd').replace(/kh/g, 'k').replace(/gh/g, 'g').replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');

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

const adm2 = JSON.parse(readFileSync(ADM2, 'utf-8'));
function shapeFor(govEn) {
  return (
    adm2.features.find((x) => normEn(x.properties.shapeName) === normEn(govEn)) ??
    adm2.features.find((x) => phonetic(normEn(x.properties.shapeName)) === phonetic(normEn(govEn))) ??
    null
  );
}

/** Bounding box, plus a radius that reflects how big this governorate
 *  actually is — half its diagonal, which is the worst case for a point
 *  placed at its centre. */
function extentOf(feature) {
  let minLat = 99, maxLat = -99, minLng = 999, maxLng = -999;
  const polys = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const p of polys)
    for (const [lng, lat] of p[0]) {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    }
  const midLat = (minLat + maxLat) / 2;
  const dLatKm = (maxLat - minLat) * 111;
  const dLngKm = (maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
  const radius = Math.round((Math.sqrt(dLatKm ** 2 + dLngKm ** 2) / 2) * 1000);
  return { minLat, maxLat, minLng, maxLng, radius };
}

const done = JSON.parse(readFileSync(CHECKPOINT, 'utf-8'));

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
  centers.push({ code, govCode: txt(row.getCell(4)), nameAr: txt(row.getCell(6)), govEn: txt(row.getCell(8)) });
});

// Only governorates that still have something to rescue.
const pending = centers.filter((c) => done[c.code]?.source !== 'nominatim' && done[c.code]?.source !== 'overpass');
const byGov = new Map();
for (const c of pending) {
  if (!byGov.has(c.govCode)) byGov.set(c.govCode, []);
  byGov.get(c.govCode).push(c);
}

console.log(`${pending.length} centers still approximate, across ${byGov.size} governorates`);
console.log(`~${Math.ceil((byGov.size * DELAY_MS) / 60000)} min at one query per governorate\n`);

async function overpass(box, attempt = 1) {
  const q = `[out:json][timeout:120];
(
  node["place"~"city|town|village|hamlet|isolated_dwelling|suburb|locality|neighbourhood"](${box.minLat},${box.minLng},${box.maxLat},${box.maxLng});
);
out center tags;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: new URLSearchParams({ data: q }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    });
    if (res.ok) return (await res.json()).elements ?? [];
    // 429/504 mean "slow down", not "no data" — backing off beats losing a
    // whole governorate's worth of villages.
    if ((res.status === 429 || res.status === 504) && attempt <= 3) {
      const wait = 30_000 * attempt;
      console.log(`     HTTP ${res.status}, waiting ${wait / 1000}s then retrying (${attempt}/3)`);
      await new Promise((r) => setTimeout(r, wait));
      return overpass(box, attempt + 1);
    }
    console.log(`     HTTP ${res.status}, giving up on this governorate`);
  } catch (e) {
    if (attempt <= 3) {
      await new Promise((r) => setTimeout(r, 20_000));
      return overpass(box, attempt + 1);
    }
    console.log(`     failed: ${String(e.message).slice(0, 70)}`);
  }
  return [];
}

let rescued = 0;
let govN = 0;
for (const group of byGov.values()) {
  govN++;
  const govEn = group[0].govEn;
  const feature = shapeFor(govEn);
  if (!feature) {
    console.log(`[${govN}/${byGov.size}] ${govEn}: no polygon, skipped`);
    continue;
  }
  const box = extentOf(feature);
  const elements = await overpass(box);

  const index = new Map();
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    // Only keep places actually inside the governorate — a bounding box
    // overlaps its neighbours, and a village from the next governorate is
    // exactly the wrong answer.
    if (!contains(feature.geometry, lng, lat)) continue;
    for (const key of ['name:ar', 'name', 'alt_name', 'official_name']) {
      const v = el.tags?.[key];
      if (!v) continue;
      const k = normAr(v);
      if (k && !index.has(k)) index.set(k, { lat, lng });
    }
  }

  let hit = 0;
  for (const c of group) {
    const found = index.get(normAr(c.nameAr));
    if (found) {
      done[c.code] = {
        lat: Number(found.lat.toFixed(6)),
        lng: Number(found.lng.toFixed(6)),
        radius: RADIUS_EXACT,
        status: 'geocoded',
        source: 'overpass',
      };
      hit++;
    } else if (done[c.code]) {
      // Left approximate, but with a radius sized to this governorate
      // rather than a flat 40km.
      done[c.code].radius = box.radius;
      done[c.code].status = `approximate (governorate centre, ±${Math.round(box.radius / 1000)}km)`;
    }
  }
  rescued += hit;
  writeFileSync(CHECKPOINT, JSON.stringify(done));
  console.log(
    `[${govN}/${byGov.size}] ${govEn.padEnd(18)} osm=${String(elements.length).padStart(4)}  pending=${String(group.length).padStart(3)}  rescued=${String(hit).padStart(3)}  radius=±${Math.round(box.radius / 1000)}km`,
  );
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

const v = Object.values(done);
console.log(`\n─── overpass pass done ───`);
console.log(`  rescued this pass       ${rescued}`);
console.log(`  exact (nominatim)       ${v.filter((d) => d.source === 'nominatim').length}`);
console.log(`  exact (overpass)        ${v.filter((d) => d.source === 'overpass').length}`);
console.log(`  approximate             ${v.filter((d) => d.source === 'governorate-fallback').length}`);
console.log(`  no coordinate           ${v.filter((d) => d.lat === null).length}`);
const exact = v.filter((d) => d.source === 'nominatim' || d.source === 'overpass').length;
console.log(`\n  exact coverage: ${exact}/${v.length}  (${Math.round((exact / v.length) * 100)}%)`);
console.log(`\n  next: node scripts/geocode-centers.mjs   (writes the JSON + workbook)`);
console.log(`        npm run geo:seed                    (loads them into the database)`);
