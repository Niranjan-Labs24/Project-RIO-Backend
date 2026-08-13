/**
 * import-domain-priority-config.ts
 *
 * Developer-only seed script. Imports domain priority weights from
 * domain-priority-baseline.csv into the `domain_priority_configs` table.
 *
 * Rules enforced before import:
 *   1. All weights must be > 0.
 *   2. Weights must sum to 1.00 (±0.001 tolerance).
 *   3. The target methodology version must not already be used by any
 *      PUBLISHED survey (immutability guard).
 *
 * Usage:
 *   pnpm import:domain-priority-config
 *   pnpm import:domain-priority-config --version "v1.0 - Approved implementation baseline"
 *   pnpm import:domain-priority-config --version "v5.0 - Approved methodology baseline" \
 *                                      --file methodology/domain-priority-v5.csv
 *
 * --file is relative to prisma/ and defaults to domain-priority-baseline.csv (the
 * pre-v5.0 5-domain file). The v5.0 baseline covers all NINE domains: the old
 * file silently omitted Energy & Environment, Social Development, Culture and
 * Governance & Services, so a village's priority score was computed from just
 * over half the methodology.
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

// ── CSV helpers ────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Resolve target methodology version (default: latest PUBLISHED)
  const versionArg = process.argv.find((_a, i) => process.argv[i - 1] === '--version');
  let mv;
  if (versionArg) {
    mv = await prisma.methodologyVersion.findFirst({ where: { version: versionArg } });
    if (!mv) {
      console.error(`Methodology version not found: "${versionArg}"`);
      process.exit(1);
    }
  } else {
    mv = await prisma.methodologyVersion.findFirst({
      where: { status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!mv) {
      console.error('No PUBLISHED methodology version found. Pass --version explicitly.');
      process.exit(1);
    }
  }

  console.log(`\nTarget: ${mv.version} (${mv.id})`);

  // ── Immutability guard: reject if version used by any published survey ──
  const publishedSurveys = await prisma.survey.count({
    where: { methodologyVersion: mv.version, status: 'PUBLISHED' },
  });
  if (publishedSurveys > 0) {
    // Check if this version already has configs — allow re-import only if
    // there are currently zero published surveys that have recorded scores.
    const existingScores = await prisma.responseSeverityScore.count({
      where: { methodologyVersionId: mv.id },
    });
    if (existingScores > 0) {
      console.error(
        `\nREJECTED: Version "${mv.version}" is already used by ${publishedSurveys} published survey(s) ` +
        `with ${existingScores} recorded severity score(s). Domain weights are immutable once scoring has occurred.`
      );
      process.exit(1);
    }
  }

  // ── Parse CSV ──────────────────────────────────────────────────────────
  const fileArg = process.argv.find((_a, i) => process.argv[i - 1] === '--file');
  const csvPath = path.join(__dirname, fileArg ?? 'domain-priority-baseline.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  console.log(`Reading domain weights from: ${csvPath}`);
  const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).filter(Boolean);
  const firstLine = lines[0];
  if (!firstLine) {
    console.error('CSV file is empty.');
    process.exit(1);
  }
  const header = parseCSVLine(firstLine).map(h => h.trim());

  const idx = {
    domainKey: header.indexOf('domainKey'),
    domainNameSnapshot: header.indexOf('domainNameSnapshot'),
    weight: header.indexOf('weight'),
    isCriticalDomain: header.indexOf('isCriticalDomain'),
    criticalPerformanceThreshold: header.indexOf('criticalPerformanceThreshold'),
  };

  if (
    idx.domainKey === -1 ||
    idx.domainNameSnapshot === -1 ||
    idx.weight === -1 ||
    idx.isCriticalDomain === -1 ||
    idx.criticalPerformanceThreshold === -1
  ) {
    console.error('CSV is missing required headers.');
    process.exit(1);
  }

  type DomainRow = {
    domainKey: string;
    domainNameSnapshot: string;
    weight: number;
    isCriticalDomain: boolean;
    criticalPerformanceThreshold: number;
  };

  const rows: DomainRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    const cols = parseCSVLine(line);
    const domainKeyVal = cols[idx.domainKey];
    const domainNameSnapshotVal = cols[idx.domainNameSnapshot];
    const weightVal = cols[idx.weight];
    const isCriticalDomainVal = cols[idx.isCriticalDomain];
    const criticalPerformanceThresholdVal = cols[idx.criticalPerformanceThreshold];

    if (
      domainKeyVal === undefined ||
      domainNameSnapshotVal === undefined ||
      weightVal === undefined ||
      isCriticalDomainVal === undefined ||
      criticalPerformanceThresholdVal === undefined
    ) {
      console.error(`Row ${i} is missing columns.`);
      process.exit(1);
    }

    const weight = parseFloat(weightVal);
    if (isNaN(weight) || weight <= 0) {
      console.error(`Row ${i}: weight must be > 0, got "${weightVal}"`);
      process.exit(1);
    }

    rows.push({
      domainKey: domainKeyVal.toUpperCase().trim(),
      domainNameSnapshot: domainNameSnapshotVal.trim(),
      weight,
      isCriticalDomain: isCriticalDomainVal.toLowerCase() === 'true',
      criticalPerformanceThreshold: parseInt(criticalPerformanceThresholdVal || '30', 10),
    });
  }

  // ── Validation: weights must sum to 1.00 ──────────────────────────────
  const weightSum = rows.reduce((s, r) => s + r.weight, 0);
  if (Math.abs(weightSum - 1.0) > 0.001) {
    console.error(`REJECTED: Weights sum to ${weightSum.toFixed(5)}, must be 1.000 (±0.001).`);
    process.exit(1);
  }

  console.log(`\nParsed ${rows.length} domain rows. Weight sum = ${weightSum.toFixed(5)} ✓`);

  // ── Upsert ────────────────────────────────────────────────────────────
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await prisma.domainPriorityConfig.findUnique({
      where: {
        methodologyVersionId_domainKey: {
          methodologyVersionId: mv.id,
          domainKey: row.domainKey,
        },
      },
    });
    if (existing) {
      await prisma.domainPriorityConfig.update({
        where: { id: existing.id },
        data: {
          domainNameSnapshot: row.domainNameSnapshot,
          weight: row.weight,
          isCriticalDomain: row.isCriticalDomain,
          criticalPerformanceThreshold: row.criticalPerformanceThreshold,
        },
      });
      updated++;
      console.log(`  ↑ Updated: ${row.domainKey} (weight=${row.weight}, critical=${row.isCriticalDomain})`);
    } else {
      await prisma.domainPriorityConfig.create({
        data: {
          methodologyVersionId: mv.id,
          domainKey: row.domainKey,
          domainNameSnapshot: row.domainNameSnapshot,
          weight: row.weight,
          isCriticalDomain: row.isCriticalDomain,
          criticalPerformanceThreshold: row.criticalPerformanceThreshold,
        },
      });
      created++;
      console.log(`  + Created: ${row.domainKey} (weight=${row.weight}, critical=${row.isCriticalDomain})`);
    }
  }

  console.log(`\nDone. Created: ${created}, Updated: ${updated}.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
