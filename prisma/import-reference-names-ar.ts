/**
 * import-reference-names-ar.ts
 *
 * Populates `name_ar` on domains, sub-domains and the geography tables from
 * `reference-names-ar.csv`.
 *
 * WHAT THIS DATA IS, AND IS NOT
 *
 * There is no Arabic vocabulary anywhere in the repository: the KSA Geographic
 * Reference workbook is explicitly the "English working copy", the question
 * bank carries no Arabic, and the BRD/Methodology workbook contains not one
 * Arabic cell. So the CSV this reads is NOT an import of client data — the
 * `region` rows are the canonical Saudi administrative names, but every
 * `domain` and `subDomain` row is a DRAFT translation that NCNP has not seen.
 *
 * That is why the CSV carries a `confidence` column, why nothing here
 * overwrites a value that already exists, and why the summary at the end
 * reports draft rows separately. Treat the draft rows as a working default that
 * makes Arabic reports legible today, not as approved terminology.
 *
 * NOT COVERED: the 150 governorates and 1,404 centres. Those are official place
 * names, and inventing 1,554 of them from English transliterations would put
 * wrong official names into government reports — a worse outcome than leaving
 * them in English, which is what an absent `name_ar` produces. Add them to the
 * CSV when the Arabic source arrives; this script needs no change to pick
 * them up.
 *
 * IDEMPOTENT, AND NON-DESTRUCTIVE BY DEFAULT
 *
 * A row whose `name_ar` is already set is left alone, so re-running this after
 * the client has supplied real wording cannot clobber it. `--force` overwrites,
 * and exists for the case where these drafts need replacing wholesale.
 *
 * Usage:
 *   npx tsx prisma/import-reference-names-ar.ts
 *   npx tsx prisma/import-reference-names-ar.ts --force
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
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

const CSV_PATH = path.join(__dirname, 'reference-names-ar.csv');
const FORCE = process.argv.includes('--force');

type Entity = 'domain' | 'subDomain' | 'region' | 'governorate' | 'center';
const ENTITIES: Entity[] = ['domain', 'subDomain', 'region', 'governorate', 'center'];

interface Row {
  entity: Entity;
  nameEn: string;
  nameAr: string;
  confidence: string;
}

/** Minimal CSV reader: comma-separated, optional double quotes, no embedded
 *  newlines. The file is hand-edited by whoever owns the vocabulary, so it is
 *  parsed strictly and complained about loudly rather than guessed at. */
function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift();
  if (!header) throw new Error('reference-names-ar.csv is empty.');

  const cols = splitCsvLine(header).map((h) => h.trim());
  const expected = ['entity', 'name_en', 'name_ar', 'confidence'];
  if (cols.join(',') !== expected.join(',')) {
    throw new Error(`Expected header "${expected.join(',')}", found "${cols.join(',')}".`);
  }

  return lines.map((line, i) => {
    const cells = splitCsvLine(line);
    if (cells.length !== 4) {
      throw new Error(`Line ${i + 2}: expected 4 columns, found ${cells.length}: ${line}`);
    }
    const [entity, nameEn, nameAr, confidence] = cells.map((c) => c.trim());
    if (!ENTITIES.includes(entity as Entity)) {
      throw new Error(`Line ${i + 2}: unknown entity "${entity}". Expected one of ${ENTITIES.join(', ')}.`);
    }
    if (!nameEn || !nameAr) throw new Error(`Line ${i + 2}: name_en and name_ar are both required.`);
    return { entity: entity as Entity, nameEn, nameAr, confidence: confidence || 'draft' };
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `updateMany` keyed on the ENGLISH name, which is what the report renderer
 *  substitutes on. Several sub-domain rows share a name under different codes;
 *  they should all carry the same translation, so matching by name is correct
 *  here rather than a limitation. */
async function applyRows(rows: Row[]) {
  const delegates = {
    domain: prisma.domain,
    subDomain: prisma.subDomain,
    region: prisma.region,
    governorate: prisma.governorate,
    center: prisma.center,
  } as const;

  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  const unmatchedNames: string[] = [];

  for (const row of rows) {
    const delegate = delegates[row.entity] as {
      updateMany: (args: unknown) => Promise<{ count: number }>;
      count: (args: unknown) => Promise<number>;
    };

    const matching = await delegate.count({ where: { name: row.nameEn } });
    if (matching === 0) {
      unmatched++;
      unmatchedNames.push(`${row.entity}: ${row.nameEn}`);
      continue;
    }

    const { count } = await delegate.updateMany({
      // Without --force this only touches rows with NO translation yet, so a
      // value the client supplied later always survives a re-run.
      where: FORCE ? { name: row.nameEn } : { name: row.nameEn, nameAr: null },
      data: { nameAr: row.nameAr },
    });
    updated += count;
    skipped += matching - count;
  }

  return { updated, skipped, unmatched, unmatchedNames };
}

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const drafts = rows.filter((r) => r.confidence !== 'canonical').length;

  console.log(`Read ${rows.length} translations (${drafts} marked draft).`);
  if (FORCE) console.log('--force: existing translations WILL be overwritten.');

  const { updated, skipped, unmatched, unmatchedNames } = await applyRows(rows);

  console.log(`\nUpdated:   ${updated} row(s)`);
  console.log(`Skipped:   ${skipped} row(s) that already had a translation`);
  if (unmatched) {
    console.log(`Unmatched: ${unmatched} CSV entr(y/ies) matched no record —`);
    for (const n of unmatchedNames) console.log(`             ${n}`);
    console.log('           (a renamed catalogue entry, or a typo in the CSV)');
  }

  // What is STILL untranslated matters more than what was just written: it is
  // exactly what an Arabic report will render in English.
  console.log('\nRemaining untranslated:');
  for (const entity of ENTITIES) {
    const delegate = (
      {
        domain: prisma.domain,
        subDomain: prisma.subDomain,
        region: prisma.region,
        governorate: prisma.governorate,
        center: prisma.center,
      } as const
    )[entity] as { count: (args?: unknown) => Promise<number> };
    const total = await delegate.count();
    const missing = await delegate.count({ where: { nameAr: null } });
    console.log(`  ${entity.padEnd(12)} ${String(missing).padStart(5)} of ${total}`);
  }

  if (drafts > 0) {
    console.log(
      `\n${drafts} of these translations are DRAFTS written for this project, not supplied by NCNP.\n` +
        `Have them reviewed before an Arabic report goes to the client.`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
