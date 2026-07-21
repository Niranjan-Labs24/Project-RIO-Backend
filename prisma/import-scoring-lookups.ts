import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// Load environment variables from .env
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not defined in the environment.");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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

function toOptionId(label: string): string {
  if (!label) return '';
  return label
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function main() {
  const csvPath = path.join(__dirname, '..', 'Village_Needs_Methodology_Implementation(Scoring Lookup).csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: CSV file not found at: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading Scoring Lookups CSV from: ${csvPath}`);
  const rawContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = rawContent.split(/\r?\n/);

  console.log(`Read ${lines.length} lines. Starting parsing...`);

  // System user UUID to associate with methodology version creation
  const systemUser = await prisma.user.findFirst();
  const systemUserId = systemUser?.id || "00000000-0000-0000-0000-000000000000";

  let importedCount = 0;
  let skippedCount = 0;

  // Header has 2 lines, data starts at index 2 (line 3)
  for (let idx = 2; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (!rawLine || !rawLine.trim()) {
      continue;
    }

    const columns = parseCSVLine(rawLine);
    const questionId = columns[0] || '';
    const responseOption = columns[2] || '';
    const severityScoreRaw = columns[3] || '';
    const scoreType = columns[4] || '';

    if (!questionId || !scoreType) {
      skippedCount++;
      continue;
    }

    // Find the question in the DB to match its details
    const question = await prisma.question.findUnique({
      where: { questionId }
    });

    if (!question) {
      console.warn(`Warning: Question ${questionId} not found in database. Skipping lookup row.`);
      skippedCount++;
      continue;
    }

    // Resolve lookup type
    let lookupType = 'OPTION';
    if (question.measurementMode === 'LIKERT_5') {
      lookupType = 'LIKERT';
    } else if (question.measurementMode === 'NUMERIC') {
      lookupType = 'NUMERIC';
    } else if (question.measurementMode === 'MULTI_SELECT') {
      lookupType = 'MULTI_SELECT';
    }

    let optionId: string | null = null;
    if (lookupType !== 'NUMERIC') {
      optionId = toOptionId(responseOption);
    }

    let severityScore: number | null = null;
    let numericFloor: number | null = null;
    let numericCeiling: number | null = null;
    let isExcluded = false;
    let exclusionReason: string | null = null;

    if (scoreType === 'Standard' || scoreType === 'Multi-select weight') {
      severityScore = parseFloat(severityScoreRaw);
    } else if (scoreType === 'Excluded from denominator') {
      isExcluded = true;
      const lowerOpt = responseOption.toLowerCase();
      if (lowerOpt.includes('not applicable') || lowerOpt.includes('n/a') || lowerOpt.includes('no children')) {
        exclusionReason = 'NOT_APPLICABLE';
      } else {
        exclusionReason = 'DONT_KNOW';
      }
    } else if (scoreType === 'Numeric-Floor') {
      numericFloor = parseFloat(severityScoreRaw);
    } else if (scoreType === 'Numeric-Ceiling') {
      numericCeiling = parseFloat(severityScoreRaw);
    }

    // Methodology version: match the versionLabel from question-bank-v1.json
    const methodologyVersionLabel = 'v1.0 - Approved implementation baseline';
    let mv = await prisma.methodologyVersion.findUnique({
      where: { version: methodologyVersionLabel }
    });
    if (!mv) {
      mv = await prisma.methodologyVersion.create({
        data: {
          name: `Methodology Version ${methodologyVersionLabel}`,
          version: methodologyVersionLabel,
          status: 'PUBLISHED',
          createdBy: systemUserId,
        }
      });
      console.log(`Created Methodology Version: ${methodologyVersionLabel}`);
    }

    const methodologyVersionId = mv.id;

    // Find and update or create
    const existing = await prisma.scoringLookup.findFirst({
      where: {
        methodologyVersionId,
        questionId,
        lookupType,
        optionId,
      }
    });

    const updateData = {
      severityScore,
      numericFloor,
      numericCeiling,
      severityDirection: question.severityDirection || 'WORSENING_HIGHER',
      isExcluded,
      exclusionReason,
    };

    if (existing) {
      await prisma.scoringLookup.update({
        where: { id: existing.id },
        data: updateData
      });
    } else {
      await prisma.scoringLookup.create({
        data: {
          methodologyVersionId,
          questionId,
          lookupType,
          optionId,
          ...updateData
        }
      });
    }
    importedCount++;
  }

  console.log(`Import completed successfully!`);
  console.log(`- Seeded: ${importedCount} scoring lookups.`);
  console.log(`- Skipped: ${skippedCount} lines.`);
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
