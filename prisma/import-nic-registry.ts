/**
 * import-nic-registry.ts
 *
 * Developer-only seed script. Imports the published register of entities and
 * supervisory units (الكيانات والوحدات الاشرافية) from
 * Entities_Supervisory_Units.xlsx into the `nic_registry` table, which
 * AuthService.signup checks every self-service registration number against.
 *
 * Idempotent: every row is an upsert keyed on `nic_number`, so re-running
 * against a newer export updates rows in place rather than duplicating them.
 *
 * Not a deleting sync: entities dropped from a later export stay in the table
 * (the gate errs towards letting a real entity register, not towards locking
 * one out on the strength of a spreadsheet diff). Prune deliberately if NIC
 * ever publishes a withdrawal list.
 *
 * Usage:
 *   npx tsx prisma/import-nic-registry.ts
 */

import * as path from 'path';
import * as dotenv from 'dotenv';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import { NIC_NUMBER_PATTERN, normalizeNicNumber } from '../src/modules/nic-registry/nic-number.util';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WORKBOOK_PATH = path.join(__dirname, '..', 'Entities_Supervisory_Units.xlsx');
const SHEET_NAME = 'Query result';

// Column positions, not header names: the sheet has three columns headed
// "Name_Ar" (B, L, M), so a header-keyed lookup would silently read the wrong
// one. Only the columns below are imported; the rest (categories, entity
// type, establishment date, supervisory org id) stay in the workbook.
const COL = {
  nameEn: 1,
  nameAr: 2,
  licenseNumber: 3,
  nicNumber: 4,
  supervisoryAgencyName: 7,
  licenseExpiryDate: 14,
} as const;

// Upserts are issued in batches rather than one-at-a-time: ~7.8k sequential
// round-trips is minutes, batched is seconds.
const BATCH_SIZE = 250;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in (value as Record<string, unknown>)) {
    // ExcelJS formula cell — {formula, result}.
    return String((value as { result: unknown }).result ?? '').trim();
  }
  if (typeof value === 'object' && 'richText' in (value as Record<string, unknown>)) {
    // Arabic names occasionally come through as rich text runs.
    return (value as { richText: { text: string }[] }).richText
      .map((r) => r.text)
      .join('')
      .trim();
  }
  return String(value).trim();
}

/** Optional descriptive column: '' becomes null rather than an empty string. */
function optionalText(value: unknown, maxLength: number): string | null {
  const text = cellText(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function cellDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value;
  const parsed = new Date(cellText(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface RegistryRow {
  nicNumber: string;
  nameEn: string | null;
  nameAr: string | null;
  licenseNumber: string | null;
  supervisoryAgencyName: string | null;
  licenseExpiryDate: Date | null;
}

async function main() {
  console.log(`Reading NIC entity registry from: ${WORKBOOK_PATH}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_PATH);

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    console.error(`Expected a "${SHEET_NAME}" sheet in the workbook.`);
    process.exit(1);
  }

  const rows: RegistryRow[] = [];
  const seen = new Set<string>();
  let blank = 0;
  let malformed = 0;
  let duplicate = 0;

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const nicNumber = normalizeNicNumber(cellText(row.getCell(COL.nicNumber).value));

    if (!nicNumber) {
      blank++;
      continue;
    }
    if (!NIC_NUMBER_PATTERN.test(nicNumber)) {
      console.warn(`Row ${r}: skipping malformed NIC number "${nicNumber}".`);
      malformed++;
      continue;
    }
    // The current export has 7,840 distinct NIC numbers and no duplicates;
    // this guards a future one, where two rows for the same entity would
    // otherwise make the batch below race against itself on one unique key.
    if (seen.has(nicNumber)) {
      console.warn(`Row ${r}: duplicate NIC number ${nicNumber}, keeping the first occurrence.`);
      duplicate++;
      continue;
    }
    seen.add(nicNumber);

    rows.push({
      nicNumber,
      nameEn: optionalText(row.getCell(COL.nameEn).value, 500),
      nameAr: optionalText(row.getCell(COL.nameAr).value, 500),
      licenseNumber: optionalText(row.getCell(COL.licenseNumber).value, 50),
      supervisoryAgencyName: optionalText(row.getCell(COL.supervisoryAgencyName).value, 500),
      licenseExpiryDate: cellDate(row.getCell(COL.licenseExpiryDate).value),
    });
  }

  console.log(
    `Parsed ${rows.length} entities (skipped: ${blank} blank, ${malformed} malformed, ${duplicate} duplicate).`,
  );

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map((data) =>
        prisma.nicRegistry.upsert({
          where: { nicNumber: data.nicNumber },
          update: data,
          create: data,
        }),
      ),
    );
    console.log(`Upserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}.`);
  }

  const total = await prisma.nicRegistry.count();
  console.log(`Import completed successfully. nic_registry now holds ${total} rows.`);
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
