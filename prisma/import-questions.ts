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

async function main() {
  const csvPath = path.join(__dirname, '..', 'Village_Needs_Methodology_Implementation(Question Bank (Extended)).csv');
  
  if (!fs.existsSync(csvPath)) {
    console.error(`Error: Question Bank CSV not found at: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading Question Bank CSV from: ${csvPath}`);
  const rawContent = fs.readFileSync(csvPath, 'utf-8');
  const lines = rawContent.split(/\r?\n/);

  console.log(`Read ${lines.length} lines. Starting parsing...`);

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
    const domain = columns[1] || '';
    const subDomain = columns[2] || '';
    const indicator = columns[3] || '';
    const kpi = columns[4] || '';
    const questionText = columns[5] || '';
    const rawAnswerType = columns[6] || '';
    const rawAnswerOptions = columns[7] || '';
    const analyticalCategory = columns[8] || null;
    const rawDependency = columns[11] || '';
    const rawDirection = columns[12] || '';

    if (!questionId || !/^[A-Z\d-]+$/i.test(questionId)) {
      skippedCount++;
      continue;
    }

    let answerType = "text";
    const typeLower = rawAnswerType.toLowerCase();
    let measurementMode = "SINGLE_SELECT";
    let isScoreable = true;

    if (typeLower.includes("likert")) {
      measurementMode = "LIKERT_5";
      answerType = "select";
    } else if (typeLower.includes("multi select") || typeLower.includes("multi-select")) {
      measurementMode = "MULTI_SELECT";
      answerType = "select";
    } else if (typeLower.includes("numeric")) {
      measurementMode = "NUMERIC";
      answerType = "numeric";
    } else if (typeLower.includes("diagnostic")) {
      measurementMode = "DIAGNOSTIC";
      isScoreable = false;
      answerType = "select";
    } else if (typeLower.includes("open text") || typeLower.includes("open-text") || typeLower === "text") {
      measurementMode = "OPEN_TEXT";
      isScoreable = false;
      answerType = "text";
    } else if (typeLower.includes("select")) {
      measurementMode = "SINGLE_SELECT";
      answerType = "select";
    } else if (typeLower.includes("boolean") || typeLower.includes("yes / no")) {
      measurementMode = "SINGLE_SELECT";
      answerType = "boolean";
    }

    let severityDirection = "WORSENING_HIGHER";
    if (rawDirection && rawDirection.toLowerCase().includes("lower=worse")) {
      severityDirection = "WORSENING_LOWER";
    }

    const scoringLookupKey = questionId;

    let answerOptions: string[] | null = null;
    if (rawAnswerOptions && rawAnswerOptions.trim() && !rawAnswerOptions.toLowerCase().includes("open numeric")) {
      answerOptions = rawAnswerOptions
        .split(' / ')
        .map(opt => opt.trim())
        .filter(opt => opt.length > 0);
    }

    let conditionalRule: any = undefined;
    if (rawDependency && rawDependency.toLowerCase() !== "unconditional") {
      if (questionId === "H10") {
        conditionalRule = { dependsOn: "H09", value: "YES" };
      } else if (questionId === "ED05") {
        conditionalRule = { dependsOn: "ED04", value: "YES" };
      } else if (questionId === "LV07") {
        conditionalRule = { dependsOn: "LV05", value: "YES" };
      } else if (questionId === "LV15") {
        conditionalRule = { dependsOn: "LV14", value: "YES" };
      } else if (questionId === "SD04") {
        conditionalRule = { dependsOn: "SD05", value: "YES" };
      } else if (questionId === "GV04") {
        conditionalRule = { dependsOn: "GV03", value: "YES" };
      } else {
        const match = rawDependency.match(/([A-Z\d]+)/i);
        if (match) {
          conditionalRule = { dependsOn: match[1], value: "YES" };
        }
      }
    }

    const requiredOptional = "required";
    const usedInMvp = true;

    await prisma.question.upsert({
      where: { questionId },
      update: {
        domain: domain || "General",
        subDomain: subDomain || "General",
        indicator: indicator || null,
        kpi: kpi || null,
        questionText: questionText || "Empty question context",
        answerType,
        answerOptions: answerOptions ? JSON.parse(JSON.stringify(answerOptions)) : null,
        requiredOptional,
        usedInMvp,
        analyticalCategory,
        measurementMode,
        isScoreable,
        severityDirection,
        scoringLookupKey,
        conditionalRule: conditionalRule !== undefined ? JSON.parse(JSON.stringify(conditionalRule)) : undefined,
      },
      create: {
        questionId,
        domain: domain || "General",
        subDomain: subDomain || "General",
        indicator: indicator || null,
        kpi: kpi || null,
        questionText: questionText || "Empty question context",
        answerType,
        answerOptions: answerOptions ? JSON.parse(JSON.stringify(answerOptions)) : null,
        requiredOptional,
        usedInMvp,
        analyticalCategory,
        measurementMode,
        isScoreable,
        severityDirection,
        scoringLookupKey,
        conditionalRule: conditionalRule !== undefined ? JSON.parse(JSON.stringify(conditionalRule)) : undefined,
      },
    });

    importedCount++;
  }

  console.log(`Import completed successfully!`);
  console.log(`- Upserted: ${importedCount} questions.`);
  console.log(`- Skipped: ${skippedCount} non-question lines.`);
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
