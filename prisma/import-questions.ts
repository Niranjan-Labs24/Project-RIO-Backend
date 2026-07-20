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
  const csvPath = path.join(__dirname, '..', '..', 'Project-RIO-Frontend', 'src', 'Project Rio 1 1(Question Bank).csv');
  
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

  for (let idx = 4; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (!rawLine || !rawLine.trim()) {
      continue;
    }

    const columns = parseCSVLine(rawLine);
    const questionId = columns[0];
    const domain = columns[1];
    const subDomain = columns[2];
    const indicator = columns[3];
    const kpi = columns[4];
    const questionText = columns[5];
    const rawAnswerType = columns[6];
    const rawAnswerOptions = columns[7];
    const requiredOptionalStr = columns[10];
    const usedInMvpStr = columns[11];
    const reportMapping = columns[12];

    if (!questionId || !/^[A-Z\d-]+$/i.test(questionId)) {
      skippedCount++;
      continue;
    }

    let answerType = "text";
    const typeLower = rawAnswerType?.toLowerCase() || "";
    if (typeLower.includes("select") || typeLower.includes("likert")) {
      answerType = "select";
    } else if (typeLower.includes("boolean")) {
      answerType = "boolean";
    } else if (typeLower.includes("numeric")) {
      answerType = "numeric";
    }

    let answerOptions: string[] | null = null;
    if (rawAnswerOptions && rawAnswerOptions.trim() && rawAnswerOptions.toLowerCase() !== "open numeric value") {
      // Options are delimited by " / " (slash with a space on each side) —
      // a bare slash with no surrounding spaces is part of an option's own
      // text (e.g. "Surface water (river/pond)", "Tanker/vendor"), not a
      // separator. Splitting on a bare '/' broke those into two options
      // each, visibly wrong in the UI (an unbalanced "(river" chip).
      answerOptions = rawAnswerOptions
        .split(' / ')
        .map(opt => opt.trim())
        .filter(opt => opt.length > 0);
    }

    const requiredOptional = requiredOptionalStr?.toLowerCase() === "required" ? "required" : "optional";
    const usedInMvp = usedInMvpStr?.toLowerCase() === "no" ? false : true;

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
        reportMapping: reportMapping || null,
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
        reportMapping: reportMapping || null,
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
