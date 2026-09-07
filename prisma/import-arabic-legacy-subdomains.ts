import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed
// 2026-09-04. The other 44 sub-domains got their Arabic name from the
// client's own bilingual Question Bank sheet (import-arabic-domains.ts).
// These remaining 10 are legacy v1.0 sub-domains (superseded by the v5.0
// methodology's renamed equivalents, e.g. "Access to Basic Healthcare" ->
// "Primary Healthcare Access") — inactive, and outside that sheet's
// coverage since it only maps the current 193-question set.
//
// Unlike the methodology-scored terms elsewhere in this pass (Study Type,
// Target Sector, Priority Scoring Factors, ...), these are plain
// descriptive labels on inactive reference rows with no scoring/wording
// precision at stake, so they're translated directly here rather than left
// blank — flagged as such, not presented as client-approved wording.
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined in the environment.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TRANSLATIONS: Record<string, string> = {
  'Accountability & Institutional Trust': 'المساءلة والثقة المؤسسية',
  'Access to Basic Healthcare': 'الوصول إلى الرعاية الصحية الأساسية',
  'Education Equity': 'العدالة التعليمية',
  'Social Safety': 'السلامة الاجتماعية',
  'Vocational Skills & Capacity': 'المهارات المهنية والقدرات',
  'Communications & Digital Connectivity': 'الاتصالات والاتصال الرقمي',
  'Cultural Programs & Participation': 'البرامج الثقافية والمشاركة',
  'Access to Government Services': 'الوصول إلى الخدمات الحكومية',
  'Access to Basic Education': 'الوصول إلى التعليم الأساسي',
  'Hygiene & Waste Management': 'النظافة وإدارة النفايات',
};

async function main() {
  let updated = 0;
  for (const [name, nameAr] of Object.entries(TRANSLATIONS)) {
    const result = await prisma.subDomain.updateMany({ where: { name }, data: { nameAr } });
    if (result.count === 0) {
      console.warn(`No SubDomain row found for "${name}".`);
    }
    updated += result.count;
  }
  console.log(`Updated ${updated}/${Object.keys(TRANSLATIONS).length} legacy sub-domain rows.`);
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
