/**
 * Seeds a spread of located, scored needs so RIO-FR-008's map can be judged
 * on something realistic.
 *
 *   node scripts/seed-map-demo-needs.mjs
 *
 * Existing demo data has almost no location and only two priority bands, so
 * the map renders four grey dots and proves nothing. This creates 24 needs
 * across eight centers in six regions, covering every urgency value, every
 * priority band, and a few deliberately left unscored — the state that shows
 * whether the colours, sizes, counters and filters actually work.
 *
 * Dev data only. Re-running it is safe: needs are keyed by title and skipped
 * if already present.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/index.js';

const app = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const supervisor = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.SUPERVISOR_DATABASE_URL }),
});

const TAG = '[MAP DEMO]';

/** One row per need. `band: null` means deliberately unscored. */
const NEEDS = [
  // ── critical ──────────────────────────────────────────────────────────
  { t: 'No safe drinking water for three months a year', d: 'Water & Sanitation', u: 'immediate', band: 'critical', score: 92, people: 1850 },
  { t: 'Clinic closed, nearest doctor 60km away', d: 'Health', u: 'immediate', band: 'critical', score: 89, people: 2400 },
  { t: 'School building structurally unsafe', d: 'Education', u: 'immediate', band: 'critical', score: 87, people: 610 },
  { t: 'Seasonal flooding cuts the only access road', d: 'Infrastructure', u: 'immediate', band: 'critical', score: 84, people: 1300, gap: 'seasonal' },
  { t: 'No emergency transport for maternity cases', d: 'Health', u: 'immediate', band: 'critical', score: 91, people: 980 },

  // ── high ──────────────────────────────────────────────────────────────
  { t: 'Water storage tanks contaminated', d: 'Water & Sanitation', u: 'this_cycle', band: 'high', score: 74, people: 1100 },
  { t: 'Secondary school has no science laboratory', d: 'Education', u: 'this_cycle', band: 'high', score: 71, people: 420 },
  { t: 'No waste collection in the southern district', d: 'Environment', u: 'this_cycle', band: 'high', score: 68, people: 1420, gap: 'chronic' },
  { t: 'Livestock disease untreated for three seasons', d: 'Livelihood', u: 'this_cycle', band: 'high', score: 66, people: 780, gap: 'chronic' },
  { t: 'Women have no local vocational training', d: 'Livelihood', u: 'this_cycle', band: 'high', score: 70, people: 1340, gap: 'inequity_linked' },
  { t: 'Power cuts during summer peak', d: 'Infrastructure', u: 'this_cycle', band: 'high', score: 72, people: 2100, gap: 'seasonal' },

  // ── medium ────────────────────────────────────────────────────────────
  { t: 'Irrigation canal silted and losing capacity', d: 'Livelihood', u: 'next_cycle', band: 'medium', score: 54, people: 470, gap: 'structural' },
  { t: 'No mobile network in the eastern quarter', d: 'Infrastructure', u: 'next_cycle', band: 'medium', score: 51, people: 640 },
  { t: 'Elderly residents have no home care support', d: 'Social Care', u: 'next_cycle', band: 'medium', score: 48, people: 60 },
  { t: 'Primary school roof leaks in the wet season', d: 'Education', u: 'next_cycle', band: 'medium', score: 55, people: 340, gap: 'seasonal' },
  { t: 'Health centre lacks basic diagnostic equipment', d: 'Health', u: 'next_cycle', band: 'medium', score: 52, people: 900 },

  // ── low ───────────────────────────────────────────────────────────────
  { t: 'No sports or youth facilities', d: 'Social Care', u: 'no_fixed_timeline', band: 'low', score: 31, people: 520 },
  { t: 'Street lighting absent on the approach road', d: 'Infrastructure', u: 'no_fixed_timeline', band: 'low', score: 28, people: 950 },
  { t: 'Public library has no current stock', d: 'Education', u: 'no_fixed_timeline', band: 'low', score: 24, people: 300 },
  { t: 'Community hall needs repair', d: 'Social Care', u: 'no_fixed_timeline', band: 'low', score: 22, people: 410 },

  // ── deliberately unscored, so "Not yet scored" has something to show ──
  { t: 'Residents report irregular refuse collection', d: null, u: 'this_cycle', band: null, people: 700 },
  { t: 'Concerns raised about school transport safety', d: null, u: 'immediate', band: null, people: 260 },
  { t: 'Requests for a weekly market space', d: null, u: 'no_fixed_timeline', band: null, people: 880 },
  { t: 'Reports of low water pressure in the north', d: null, u: 'next_cycle', band: null, people: 1050 },
];

async function main() {
  // Eight centers that have coordinates, spread across regions so the map
  // is not one cluster.
  const centers = await supervisor.$queryRawUnsafe(`
    SELECT DISTINCT ON (r.id) c.id, c.name, c.governorate_id, g.name AS gov, r.name AS region
    FROM centers c
    JOIN governorates g ON g.id = c.governorate_id
    JOIN regions r ON r.id = g.region_id
    WHERE c.latitude IS NOT NULL AND c.coordinate_source IN ('nominatim','overpass')
      AND g.latitude IS NOT NULL
    ORDER BY r.id, c.name
    LIMIT 8`);

  if (centers.length < 4) {
    console.error('Not enough located centers to spread across — run geo:seed first.');
    process.exit(1);
  }

  // Seed into the org whose NGO Admin someone will actually log in as.
  // Picking "the newest study anywhere" put the first run into a different
  // tenant, where row-level security correctly hid every one of them.
  const [actor] = await supervisor.$queryRawUnsafe(`
    SELECT u.id, u.org_id, o.name AS org FROM users u
    JOIN organisations o ON o.id = u.org_id
    WHERE u.role_id = 'role_ngo_admin' AND o.is_active = true AND u.status = 'active'
    ORDER BY u.created_at LIMIT 1`);
  const [study] = await supervisor.$queryRawUnsafe(
    `SELECT id, org_id, title FROM studies
     WHERE org_id = $1 AND is_historical = false
     ORDER BY created_at DESC LIMIT 1`,
    actor.org_id,
  );
  if (!study) {
    console.error(`No non-historical study in ${actor.org} to attach needs to.`);
    process.exit(1);
  }
  console.log(`org   : ${actor.org}`);

  console.log(`study : ${study.title}`);
  console.log(`spread: ${centers.length} centers across ${new Set(centers.map((c) => c.region)).size} regions\n`);

  await app.$executeRawUnsafe(`SELECT set_config('app.current_org_id', '${study.org_id}', false)`);

  let created = 0;
  let scored = 0;
  for (let i = 0; i < NEEDS.length; i++) {
    const n = NEEDS[i];
    const center = centers[i % centers.length];
    const title = `${TAG} ${n.t}`;

    const existing = await supervisor.$queryRawUnsafe(
      `SELECT id FROM needs WHERE study_id = $1 AND title = $2 LIMIT 1`,
      study.id,
      title,
    );
    if (existing.length) continue;

    const need = await app.need.create({
      data: {
        studyId: study.id,
        orgId: study.org_id,
        title,
        statement: `${n.t}. Recorded at ${center.name} (${center.gov}, ${center.region}) for map demonstration.`,
        village: [center.name],
        source: 'manual_entry',
        // Scored needs are treated as reviewed; unscored ones sit earlier in
        // the workflow, which is also what makes the status filter meaningful.
        status: n.band ? 'reviewer_approved' : 'ai_classified',
        urgency: n.u,
        domain: n.d,
        affectedPopulation: n.people,
        createdBy: actor.id,
        needCenters: { create: [{ orgId: study.org_id, centerId: center.id }] },
        needGovernorates: { create: [{ orgId: study.org_id, governorateId: center.governorate_id }] },
      },
      select: { id: true },
    });
    created++;

    if (n.band) {
      await app.priorityScore.create({
        data: {
          orgId: study.org_id,
          needId: need.id,
          studyId: study.id,
          overallScore: n.score,
          level: n.band,
          gapType: n.gap ?? 'acute',
          factors: { seeded: true, note: 'Map demonstration data' },
        },
      });
      scored++;
    }
    process.stdout.write(
      `\r  ${created} needs created (${scored} scored)  latest: ${center.name.slice(0, 18)}          `,
    );
  }
  console.log();

  const summary = await supervisor.$queryRawUnsafe(`
    SELECT COALESCE(ps.level::text, 'unscored') AS band, COUNT(*)::int AS n
    FROM needs nd LEFT JOIN priority_scores ps ON ps.need_id = nd.id
    WHERE nd.title LIKE '${TAG}%' GROUP BY 1 ORDER BY 2 DESC`);
  const byUrgency = await supervisor.$queryRawUnsafe(`
    SELECT urgency, COUNT(*)::int AS n FROM needs
    WHERE title LIKE '${TAG}%' GROUP BY 1 ORDER BY 2 DESC`);

  console.log('\nby priority band:');
  summary.forEach((r) => console.log(`   ${String(r.band).padEnd(10)} ${r.n}`));
  console.log('by urgency:');
  byUrgency.forEach((r) => console.log(`   ${String(r.urgency).padEnd(18)} ${r.n}`));

  await app.$disconnect();
  await supervisor.$disconnect();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  await app.$disconnect();
  await supervisor.$disconnect();
  process.exit(1);
});
