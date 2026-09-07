/**
 * import-arabic-geography.ts
 *
 * RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
 * 2026-09-04. Patches `name_ar` onto the already-imported KSA Geographic
 * Reference (regions/governorates/centers — see import-geography.ts, which
 * seeded these tables from the English-only KSA_Geographic_Reference_EN.xlsx)
 * using the client-supplied bilingual workbook
 * RIO-Reference-docs/KSA_Geographic_Reference_ENRICHED_1.xlsx, matched by
 * each table's own `code` — the same key both workbooks share.
 *
 * Idempotent: an update keyed on `code`, safe to re-run.
 *
 * Usage:
 *   npx tsx prisma/import-arabic-geography.ts
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

const WORKBOOK_PATH = path.join(
  __dirname,
  '..',
  '..',
  'RIO-Reference-docs',
  'KSA_Geographic_Reference_ENRICHED_1.xlsx',
);

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    return String((value as { result: unknown }).result ?? '');
  }
  return String(value).trim();
}

async function main() {
  console.log(`Reading KSA Geographic Reference (Arabic) from: ${WORKBOOK_PATH}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_PATH);

  const regionsSheet = workbook.getWorksheet('المناطق Regions');
  const governoratesSheet = workbook.getWorksheet('المحافظات Governorates');
  const centersSheet = workbook.getWorksheet('المراكز Centers');
  if (!regionsSheet || !governoratesSheet || !centersSheet) {
    console.error('Expected the Regions/Governorates/Centers sheets in the ENRICHED workbook.');
    process.exit(1);
  }

  // ── Regions ── col1: Region Code (numeric), col2: Region (AR), col3: Region (EN)
  let regionUpdated = 0;
  let regionMissed = 0;
  for (let r = 2; r <= regionsSheet.rowCount; r++) {
    const row = regionsSheet.getRow(r);
    const codeText = cellText(row.getCell(1).value);
    if (!codeText) continue;
    const code = Number(codeText);
    const nameAr = cellText(row.getCell(2).value);
    if (!nameAr) continue;
    const result = await prisma.region.updateMany({ where: { code }, data: { nameAr } });
    if (result.count === 0) {
      console.warn(`Region code ${code}: no matching DB row.`);
      regionMissed++;
    } else {
      regionUpdated++;
    }
  }
  console.log(`Regions: updated ${regionUpdated}, missed ${regionMissed}.`);

  // ── Governorates ── col1: Gov Code, col4: Governorate (AR)
  let govUpdated = 0;
  let govMissed = 0;
  for (let r = 2; r <= governoratesSheet.rowCount; r++) {
    const row = governoratesSheet.getRow(r);
    const code = cellText(row.getCell(1).value);
    if (!code) continue;
    const nameAr = cellText(row.getCell(4).value);
    if (!nameAr) continue;
    const result = await prisma.governorate.updateMany({ where: { code }, data: { nameAr } });
    if (result.count === 0) {
      console.warn(`Governorate code ${code}: no matching DB row.`);
      govMissed++;
    } else {
      govUpdated++;
    }
  }
  console.log(`Governorates: updated ${govUpdated}, missed ${govMissed}.`);

  // ── Centers ── col1: Center Code, col6: Center (AR)
  let centerUpdated = 0;
  let centerMissed = 0;
  for (let r = 2; r <= centersSheet.rowCount; r++) {
    const row = centersSheet.getRow(r);
    const code = cellText(row.getCell(1).value);
    if (!code) continue;
    const nameAr = cellText(row.getCell(6).value);
    if (!nameAr) continue;
    const result = await prisma.center.updateMany({ where: { code }, data: { nameAr } });
    if (result.count === 0) {
      console.warn(`Center code ${code}: no matching DB row.`);
      centerMissed++;
    } else {
      centerUpdated++;
    }
  }
  console.log(`Centers: updated ${centerUpdated}, missed ${centerMissed}.`);
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
