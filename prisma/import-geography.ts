/**
 * import-geography.ts
 *
 * Developer-only seed script. Imports the KSA Geographic Reference
 * (Region -> Governorate -> Center) from KSA_Geographic_Reference_EN.xlsx
 * into the `regions` / `governorates` / `centers` tables.
 *
 * Idempotent: every row is an upsert keyed on the source spreadsheet's own
 * `code` column, so running this repeatedly updates existing rows in place
 * rather than creating duplicates.
 *
 * Order matters — Regions first (Governorates reference them by code),
 * then Governorates (Centers reference them by code).
 *
 * Usage:
 *   npx tsx prisma/import-geography.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WORKBOOK_PATH = path.join(__dirname, '..', 'KSA_Geographic_Reference_EN.xlsx');

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    // ExcelJS formula cell — {formula, result}. Not expected on the columns
    // this script reads (those are all plain values), but handled
    // defensively rather than silently stringifying "[object Object]".
    return String((value as { result: unknown }).result ?? '');
  }
  return String(value).trim();
}

function cellNumber(value: unknown): number {
  const text = cellText(value);
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a numeric cell, got: ${JSON.stringify(value)}`);
  }
  return n;
}

async function main() {
  console.log(`Reading KSA Geographic Reference from: ${WORKBOOK_PATH}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_PATH);

  const regionsSheet = workbook.getWorksheet('Regions');
  const governoratesSheet = workbook.getWorksheet('Governorates');
  const centersSheet = workbook.getWorksheet('Centers');
  if (!regionsSheet || !governoratesSheet || !centersSheet) {
    console.error('Expected "Regions", "Governorates", and "Centers" sheets in the workbook.');
    process.exit(1);
  }

  // ── Regions ── columns: Region Code, Region, ISO 3166-2, Region Capital, ...
  let regionCount = 0;
  for (let r = 2; r <= regionsSheet.rowCount; r++) {
    const row = regionsSheet.getRow(r);
    const code = cellText(row.getCell(1).value);
    if (!code) continue;
    const name = cellText(row.getCell(2).value);
    const isoCode = cellText(row.getCell(3).value);
    const capital = cellText(row.getCell(4).value);

    await prisma.region.upsert({
      where: { code: cellNumber(code) },
      update: { name, isoCode, capital },
      create: { code: cellNumber(code), name, isoCode, capital },
    });
    regionCount++;
  }
  console.log(`Regions: upserted ${regionCount}.`);

  // Resolve region code -> Region.id for the Governorates pass below (FK is
  // by id, source data references regions by their numeric code).
  const regions = await prisma.region.findMany({ select: { id: true, code: true } });
  const regionIdByCode = new Map(regions.map((r) => [r.code, r.id]));

  // ── Governorates ── columns: Gov Code, Region Code, Region, Governorate, Category, ...
  let governorateCount = 0;
  let governorateSkipped = 0;
  for (let r = 2; r <= governoratesSheet.rowCount; r++) {
    const row = governoratesSheet.getRow(r);
    const code = cellText(row.getCell(1).value);
    if (!code) continue;
    const regionCode = cellNumber(row.getCell(2).value);
    const name = cellText(row.getCell(4).value);
    const category = cellText(row.getCell(5).value);

    const regionId = regionIdByCode.get(regionCode);
    if (!regionId) {
      console.warn(`Skipping Governorate ${code} (${name}): unknown Region Code ${regionCode}.`);
      governorateSkipped++;
      continue;
    }

    await prisma.governorate.upsert({
      where: { code },
      update: { regionId, name, category },
      create: { code, regionId, name, category },
    });
    governorateCount++;
  }
  console.log(`Governorates: upserted ${governorateCount}, skipped ${governorateSkipped}.`);

  // Resolve governorate code -> Governorate.id for the Centers pass below.
  const governorates = await prisma.governorate.findMany({ select: { id: true, code: true } });
  const governorateIdByCode = new Map(governorates.map((g) => [g.code, g.id]));

  // ── Centers ── columns: Center Code, Region Code, Region, Gov Code, Parent Governorate, Center, Center Category
  let centerCount = 0;
  let centerSkipped = 0;
  for (let r = 2; r <= centersSheet.rowCount; r++) {
    const row = centersSheet.getRow(r);
    const code = cellText(row.getCell(1).value);
    if (!code) continue;
    const govCode = cellText(row.getCell(4).value);
    const name = cellText(row.getCell(6).value);
    const category = cellText(row.getCell(7).value);

    const governorateId = governorateIdByCode.get(govCode);
    if (!governorateId) {
      console.warn(`Skipping Center ${code} (${name}): unknown Gov Code ${govCode}.`);
      centerSkipped++;
      continue;
    }

    await prisma.center.upsert({
      where: { code },
      update: { governorateId, name, category },
      create: { code, governorateId, name, category },
    });
    centerCount++;
  }
  console.log(`Centers: upserted ${centerCount}, skipped ${centerSkipped}.`);

  console.log('Import completed successfully.');
}

main()
  .catch((e) => {
    console.error('Import process failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
