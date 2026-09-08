/**
 * RIO-FR-008 — loads map coordinates onto the geography master data.
 *
 *   npm run geo:seed
 *
 * Reads `prisma/data/<level>-coordinates.json`, keyed by the same codes the
 * KSA Geographic Reference uses, and writes latitude/longitude onto the
 * matching rows. Idempotent: re-running it just rewrites the same values.
 *
 * Governorate coordinates exist today, derived from geoBoundaries ADM2.
 * Center coordinates do not — no public dataset publishes them for Saudi
 * Arabia. When the client supplies them, drop a
 * `center-coordinates.json` in the same shape next to this file and this
 * script picks it up with no code change. That is the whole point of driving
 * both levels off one loader.
 */
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import 'dotenv/config';

interface CoordinateFile {
  coordinates: Record<string, { lat: number; lng: number; source?: string }>;
}

type Level = 'governorate' | 'center';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function load(level: Level): CoordinateFile['coordinates'] | null {
  const file = path.join(__dirname, 'data', `${level}-coordinates.json`);
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, 'utf-8')) as CoordinateFile).coordinates;
}

async function seedLevel(level: Level): Promise<void> {
  const coords = load(level);
  if (!coords) {
    console.log(`\n${level}: no data/${level}-coordinates.json — skipped.`);
    if (level === 'center') {
      console.log('  (expected until the client supplies center coordinates)');
    }
    return;
  }

  // Read the codes that actually exist, so a coordinate for a place we do
  // not carry is reported rather than silently dropped.
  const rows =
    level === 'governorate'
      ? await prisma.governorate.findMany({ select: { id: true, code: true, name: true } })
      : await prisma.center.findMany({ select: { id: true, code: true, name: true } });

  const byCode = new Map(rows.map((r) => [r.code, r]));
  let written = 0;
  const noRow: string[] = [];

  for (const [code, point] of Object.entries(coords)) {
    const row = byCode.get(code);
    if (!row) {
      noRow.push(code);
      continue;
    }
    const data = { latitude: point.lat, longitude: point.lng };
    if (level === 'governorate') {
      await prisma.governorate.update({ where: { id: row.id }, data });
    } else {
      await prisma.center.update({ where: { id: row.id }, data });
    }
    written++;
  }

  const missing = rows.filter((r) => !coords[r.code]);
  console.log(`\n${level}:`);
  console.log(`  ${written} of ${rows.length} rows given coordinates`);
  if (noRow.length) {
    console.log(`  ${noRow.length} coordinate(s) had no matching row: ${noRow.slice(0, 6).join(', ')}`);
  }
  if (missing.length) {
    console.log(`  ${missing.length} still without coordinates — these will not appear on the map:`);
    for (const m of missing.slice(0, 10)) console.log(`     ${m.code}  ${m.name}`);
    if (missing.length > 10) console.log(`     ... and ${missing.length - 10} more`);
  }
}

async function main(): Promise<void> {
  await seedLevel('governorate');
  await seedLevel('center');

  const plottable = await prisma.governorate.count({ where: { latitude: { not: null } } });
  const centersPlottable = await prisma.center.count({ where: { latitude: { not: null } } });
  console.log(`\nready to plot: ${plottable} governorates, ${centersPlottable} centers`);
  await prisma.$disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exit(1);
});
