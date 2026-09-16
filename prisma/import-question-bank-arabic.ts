import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed 2026-09-04.
//
// Question_Bank.xlsx (under RIO-Reference-docs/) carries two parallel
// sheets — "QB English" and "QB Arabic" — both keyed row-for-row by Q Code
// against the same 193-question v5.0 baseline already loaded into the
// `questions` table (see prisma/import-methodology.ts /
// prisma/methodology/question-bank-v5.json). This is NOT machine
// translation: the client supplied the Arabic sheet directly, so it's
// loaded as-is rather than run through any AI translation step.
//
// question-bank-arabic-source.json is that workbook pre-extracted to plain
// JSON (see the one-off Python extraction this script's own commit
// message/PR references) — done to avoid adding an `xlsx` npm dependency
// just for this one-time import.
//
// Updates every row for a given questionId (all versions, not just
// isCurrentVersion) — Arabic text is a localization patch to existing
// content, not a methodology edit, so it deliberately bypasses the
// version/approval workflow QuestionsService enforces for actual wording
// changes to the English methodology.
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined in the environment.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface QbRow {
  qCode: string;
  domain: string | null;
  subDomain: string | null;
  indicator: string | null;
  kpi: string | null;
  questionText: string | null;
  responseOptions: string | null;
}

interface SourceFile {
  english: QbRow[];
  arabic: QbRow[];
}

// English "Yes / No / Don't know" <-> Arabic "نعم / لا / لا أعلم" split the
// same way, positionally — this is how the source workbook itself pairs
// them (same " / " separator, same option order) rather than anything this
// script infers.
function splitOptions(raw: string | null): string[] | null {
  if (!raw) return null;
  return raw.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
}

async function main() {
  const jsonPath = path.join(__dirname, 'question-bank-arabic-source.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: ${jsonPath} not found. Re-run the extraction step against RIO-Reference-docs/Question_Bank.xlsx first.`);
    process.exit(1);
  }
  const { english, arabic }: SourceFile = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  if (english.length !== arabic.length) {
    console.error(`Row count mismatch: QB English has ${english.length}, QB Arabic has ${arabic.length}.`);
    process.exit(1);
  }

  const arabicByCode = new Map(arabic.map((r) => [r.qCode, r]));

  let matched = 0;
  let updatedRows = 0;
  let mismatchedOptionCounts = 0;

  for (const en of english) {
    const ar = arabicByCode.get(en.qCode);
    if (!ar) {
      console.warn(`No Arabic row found for ${en.qCode} — skipped.`);
      continue;
    }
    matched++;

    const enOptions = splitOptions(en.responseOptions);
    const arOptions = splitOptions(ar.responseOptions);
    if (enOptions && arOptions && enOptions.length !== arOptions.length) {
      mismatchedOptionCounts++;
      console.warn(
        `${en.qCode}: option count mismatch (EN ${enOptions.length} vs AR ${arOptions.length}) — ` +
          `storing Arabic options anyway, but they may not align positionally with answerOptions.`,
      );
    }

    const result = await prisma.question.updateMany({
      where: { questionId: en.qCode },
      data: {
        questionTextAr: ar.questionText ?? undefined,
        indicatorAr: ar.indicator ?? undefined,
        kpiAr: ar.kpi ?? undefined,
        answerOptionsAr: arOptions ?? undefined,
      },
    });
    updatedRows += result.count;
    if (result.count === 0) {
      console.warn(`${en.qCode}: matched in the workbook but no "questions" row exists with that questionId.`);
    }
  }

  console.log(`Matched ${matched}/${english.length} question codes between EN/AR sheets.`);
  console.log(`Updated ${updatedRows} "questions" DB rows (across all versions of each questionId).`);
  if (mismatchedOptionCounts > 0) {
    console.log(`${mismatchedOptionCounts} question(s) had a differing EN/AR option count — review those manually.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
