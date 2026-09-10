/**
 * Turns geoBoundaries SAU ADM2 polygons into a committed
 * `code -> {lat, lng}` file keyed by OUR governorate codes.
 *
 *   node scripts/build-geo-coordinates.mjs
 *
 * Run it once and commit the output; `npm run geo:seed` then loads that file
 * and never touches the network. Regenerate only if the source data changes.
 *
 * Matching is by name because the two datasets share no code. The two use
 * different transliteration systems ("Ad-Dawadmi" vs "Ad Duwadimi"), so it
 * runs exact -> fuzzy -> a hand-written alias list, and reports anything
 * still unmatched rather than guessing.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import ExcelJS from 'exceljs';

const OUT = './prisma/data/governorate-coordinates.json';
const CACHE = './prisma/data/.geoboundaries';

// geoBoundaries publishes ADM1 (regions) and ADM2 (governorates) for Saudi
// Arabia. There is no ADM3, which is exactly why center coordinates cannot be
// produced this way and have to come from the client.
const SOURCES = {
  adm1: 'https://www.geoboundaries.org/api/current/gbOpen/SAU/ADM1/',
  adm2: 'https://www.geoboundaries.org/api/current/gbOpen/SAU/ADM2/',
};

/** Downloads a level's simplified GeoJSON once and caches it, so re-runs are
 *  offline and the output stays reproducible. */
async function fetchLevel(level) {
  const cached = `${CACHE}/sau-${level}.geojson`;
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf-8'));
  mkdirSync(CACHE, { recursive: true });
  const meta = await (await fetch(SOURCES[level])).json();
  const body = await (await fetch(meta.simplifiedGeometryGeoJSON)).text();
  writeFileSync(cached, body);
  return JSON.parse(body);
}

/** Collapses the article prefixes and punctuation the two transliterations
 *  disagree on, so "An-Nuayriyah" and "Al Nuayriyah" reduce to one key. */
function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/\bgovernorate\b/g, '')
    .replace(/\bmuhafazat\b/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/['`\u2018\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(al|an|ad|as|ash|at|az|ar|el)\s+/, '')
    .replace(/\s+/g, '');
}

/** Further flattens the sounds that differ purely by transliteration
 *  convention, so "duwadimi" and "dawadmi" collapse together. */
function phonetic(k) {
  return k
    .replace(/dh|th/g, 'd')
    .replace(/kh/g, 'k')
    .replace(/gh/g, 'g')
    .replace(/ou|uu|oo/g, 'u')
    .replace(/ii|ee|ay|ai/g, 'i')
    .replace(/[aeiou]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return m[a.length][b.length];
}

/** Centroid of the largest ring, which for an irregular governorate sits
 *  inside the shape far more reliably than a bounding-box midpoint. */
function centroid(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      const f = x0 * y1 - x1 * y0;
      area += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    area /= 2;
    if (Math.abs(area) > bestArea) {
      bestArea = Math.abs(area);
      best = area === 0 ? ring[0] : [cx / (6 * area), cy / (6 * area)];
    }
  }
  return { lng: Number(best[0].toFixed(6)), lat: Number(best[1].toFixed(6)) };
}

// Places the automatic passes cannot join — verified by hand against the
// parent region so a wrong join cannot put a governorate in the wrong place.
const ALIASES = {
  '0202': 'Jeddah',
  '0501': 'Ad Dammam',
  '0602': 'Khamis Mushayt',
  '0304': 'Al Mahd', // Mahd Adh-Dhahab
  '0605': 'Muhayil', // Muhayil Asir
  '1209': 'Farat Ghamid Az Zinad', // Ghamid Az-Zinad
  '1303': 'Dawamat Al Jandal', // Dumat Al-Jandal
  // 0214 Al-Muwayh has no shape in geoBoundaries ADM2. Deliberately left
  // without coordinates rather than guessed: a governorate plotted in the
  // wrong place is worse than one that does not plot, because someone will
  // read funding priority off this map.
};

// ── region validation ────────────────────────────────────────────────────
// Name matching alone is not safe: "Dammam" has no ADM2 shape at all, and a
// loose fuzzy pass happily matched it to "Adam" — a different governorate
// 600km away in Al-Baha. Every candidate is therefore checked against its
// own region's polygon, and a point that lands outside is thrown away.
// Keyed by norm() of OUR region name -> norm() of the geoBoundaries name.
// Written out in full rather than guessed by prefix, because a region that
// silently fails to resolve turns validation off without saying so — which
// is exactly how "Dammam -> Adam" slipped through the first time.
const REGION_ALIASES = {
  riyadh: 'riyadhregion',
  makkahalmukarramah: 'makkahregion',
  madinahalmunawwarah: 'madinahregion',
  qassim: 'qassimregion',
  easternprovince: 'easternregion',
  aseer: 'asirregion',
  tabuk: 'tabukregion',
  hail: 'hayelregion',
  northernborders: 'northernbordersregion',
  jazan: 'jazanregion',
  najran: 'najranregion',
  baha: 'bahahregion',
  jouf: 'jawfregion',
};

function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function geometryContains(geometry, lng, lat) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    if (ringContains(poly[0], lng, lat)) {
      // Subtract holes, so a point in a donut's hole is not counted inside.
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (ringContains(poly[h], lng, lat)) inHole = true;
      if (!inHole) return true;
    }
  }
  return false;
}

const adm1 = await fetchLevel('adm1');
const regionShapes = new Map();
for (const f of adm1.features) {
  regionShapes.set(norm(f.properties.shapeName), f.geometry);
}

/** Region polygon for one of our region names, or null if we cannot pin it. */
function regionGeometry(regionName) {
  const k = norm(regionName);
  const g = regionShapes.get(k) ?? regionShapes.get(REGION_ALIASES[k] ?? '');
  if (!g) {
    // Refuse to continue rather than quietly disable the check for a whole
    // region's worth of governorates.
    throw new Error(
      `No ADM1 polygon for region "${regionName}" (key "${k}"). Add it to REGION_ALIASES.`,
    );
  }
  return g;
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile('./KSA_Geographic_Reference_EN.xlsx');
const ours = [];
wb.getWorksheet('Governorates').eachRow((row, n) => {
  if (n === 1) return;
  const code = String(row.getCell(1).value ?? '').trim();
  const region = String(row.getCell(3).value ?? '').trim();
  const name = String(row.getCell(4).value ?? '').trim();
  if (code && name) ours.push({ code, name, region });
});

const gj = await fetchLevel('adm2');
const shapes = gj.features.map((f) => ({
  name: f.properties.shapeName,
  key: norm(f.properties.shapeName),
  ph: phonetic(norm(f.properties.shapeName)),
  point: centroid(f.geometry),
}));

const byKey = new Map(shapes.map((s) => [s.key, s]));
const byPh = new Map();
for (const s of shapes) if (!byPh.has(s.ph)) byPh.set(s.ph, s);

const out = {};
const report = { exact: 0, phonetic: 0, fuzzy: 0, alias: 0, unmatched: [], rejected: [], borderline: [] };

for (const g of ours) {
  const key = norm(g.name);
  let shape = byKey.get(key);
  let how = 'exact';

  if (!shape && ALIASES[g.code]) {
    shape = shapes.find((s) => s.name === ALIASES[g.code]) ?? byKey.get(norm(ALIASES[g.code]));
    how = 'alias';
  }
  if (!shape) {
    shape = byPh.get(phonetic(key));
    how = 'phonetic';
  }
  if (!shape) {
    let best = null;
    let bestD = 99;
    for (const s of shapes) {
      const d = levenshtein(key, s.key);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    // 2 edits on a short name is already generous; beyond that a "match" is
    // more likely to be a different place than a spelling variant.
    if (best && bestD <= 2) {
      shape = best;
      how = 'fuzzy';
    }
  }

  // A name match is only trusted once the point lands inside its own
  // region. This is what catches Dammam -> "Adam".
  if (shape) {
    const rg = regionGeometry(g.region);
    if (!geometryContains(rg, shape.point.lng, shape.point.lat)) {
      if (how === 'exact' || how === 'alias') {
        // The name is an exact match, so the likeliest explanation is a
        // simplified border, not a wrong place. Keep it, but say so.
        report.borderline.push(`${g.code} ${g.name} -> "${shape.name}" sits just outside ${g.region}`);
      } else {
        report.rejected.push(`${g.code} ${g.name} -> "${shape.name}" fell outside ${g.region}`);
        shape = null;
      }
    }
  }

  if (shape) {
    out[g.code] = { lat: shape.point.lat, lng: shape.point.lng, source: shape.name, match: how };
    report[how]++;
  } else {
    report.unmatched.push(`${g.code} ${g.name}`);
  }
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'Governorate centroids derived from geoBoundaries gbOpen SAU ADM2 (CC-BY 4.0). Keyed by the KSA Geographic Reference Gov Code. Regenerate with scripts/_build-governorate-coords.mjs.',
      _source: 'https://www.geoboundaries.org/api/current/gbOpen/SAU/ADM2/',
      _generated: new Date().toISOString().slice(0, 10),
      coordinates: out,
    },
    null,
    2,
  ) + '\n',
);

const total = ours.length;
const got = Object.keys(out).length;
console.log(`matched ${got}/${total} (${Math.round((got / total) * 100)}%)`);
console.log(`  exact ${report.exact} | phonetic ${report.phonetic} | fuzzy ${report.fuzzy} | alias ${report.alias}`);
if (report.borderline.length) {
  console.log(`
kept despite the region check (${report.borderline.length}) — exact name match, simplified border:`);
  report.borderline.forEach((r) => console.log(`   ${r}`));
}
if (report.rejected.length) {
  console.log(`
rejected by the region check (${report.rejected.length}) — a name matched but the point was in the wrong region:`);
  report.rejected.forEach((r) => console.log(`   ${r}`));
}
if (report.unmatched.length) {
  console.log(`\nstill unmatched (${report.unmatched.length}) — these get no coordinates and simply will not plot:`);
  report.unmatched.forEach((u) => console.log(`   ${u}`));
}
console.log(`\nwritten to ${OUT}`);
