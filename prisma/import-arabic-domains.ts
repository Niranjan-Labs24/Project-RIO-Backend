import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
// 2026-09-04. Domain/Sub-domain Arabic names are derived from the same
// client-supplied Question_Bank.xlsx "QB Arabic" sheet already used for
// question text (see import-question-bank-arabic.ts and its
// question-bank-arabic-source.json extraction) — every question row also
// names its Domain and Sub-domain, in English and Arabic, so this is a
// genuine client-approved source, not a guess or a machine translation.
//
// Not every `domains`/`sub_domains` DB row is guaranteed a match: the
// question bank's own domain/sub-domain set is scoped to the 193 fielded
// questions, while the DB tables carry a slightly larger reference list
// (54 sub-domains vs. 44 that appear on an actual question) — anything
// unmatched here is reported, not silently left as a guess.
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
  domain: string | null;
  subDomain: string | null;
}
interface SourceFile {
  english: QbRow[];
  arabic: QbRow[];
}

async function main() {
  const jsonPath = path.join(__dirname, 'question-bank-arabic-source.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: ${jsonPath} not found.`);
    process.exit(1);
  }
  const { english, arabic }: SourceFile = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  const domainMap = new Map<string, string>();
  const subDomainMap = new Map<string, string>();
  english.forEach((en, i) => {
    const ar = arabic[i];
    if (!ar) return;
    if (en.domain && ar.domain) domainMap.set(en.domain, ar.domain);
    if (en.subDomain && ar.subDomain) subDomainMap.set(en.subDomain, ar.subDomain);
  });

  const domains = await prisma.domain.findMany();
  let domainUpdated = 0;
  for (const d of domains) {
    const nameAr = domainMap.get(d.name);
    if (!nameAr) {
      console.warn(`Domain "${d.name}": no Arabic match found in the question bank — left unset.`);
      continue;
    }
    await prisma.domain.update({ where: { id: d.id }, data: { nameAr } });
    domainUpdated++;
  }
  console.log(`Domain: updated ${domainUpdated}/${domains.length} rows.`);

  const subDomains = await prisma.subDomain.findMany();
  let subUpdated = 0;
  for (const sd of subDomains) {
    const nameAr = subDomainMap.get(sd.name);
    if (!nameAr) {
      console.warn(`SubDomain "${sd.name}": no Arabic match found in the question bank — left unset.`);
      continue;
    }
    await prisma.subDomain.update({ where: { id: sd.id }, data: { nameAr } });
    subUpdated++;
  }
  console.log(`SubDomain: updated ${subUpdated}/${subDomains.length} rows.`);
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
