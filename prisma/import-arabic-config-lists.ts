import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';

// RIO Arabic Localization — Approach 3 (Hybrid), client-confirmed 2026-09-04.
// One-time population of `nameAr` for the 5 configurable lists the client
// has already approved Arabic wording for (RIO-Reference-docs/
// arabic-translation-client-approved.md, client-reviewed 4 September 2026).
// Values copied verbatim from that document — includes the 3 corrections
// the client made vs. the original draft (Target Sector's "Other /
// Cross-sectoral", Need Theme's "Skills and employability" and "Elderly and
// disability", Gap Type's "equity").
dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not defined in the environment.');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const STUDY_TYPE: Record<string, string> = {
  'Baseline Assessment': 'تقييم خط الأساس',
  'Endline Assessment': 'التقييم الختامي',
  'Rapid Needs Assessment': 'تقييم سريع للاحتياجات',
  'Follow-up / Monitoring Study': 'دراسة متابعة / رصد',
  'Follow-up Assessment': 'تقييم المتابعة',
  'Thematic Study': 'دراسة موضوعية',
  'Thematic / Sector-Specific Study': 'دراسة موضوعية / قطاعية',
  'Impact Evaluation': 'تقييم الأثر',
};

const TARGET_SECTOR: Record<string, string> = {
  'Water & Sanitation': 'المياه والصرف الصحي',
  Health: 'الصحة',
  'Social Development': 'التنمية الاجتماعية',
  Education: 'التعليم',
  'WASH (Water, Sanitation & Hygiene)': 'المياه والصرف الصحي والنظافة الصحية',
  Environment: 'البيئة',
  Livelihoods: 'سبل العيش',
  'Economic Empowerment': 'التمكين الاقتصادي',
  Protection: 'الحماية',
  'Culture & Arts': 'الثقافة والفنون',
  'Multi-Sector': 'متعدد القطاعات',
  "Da'wah & Islamic Affairs": 'الدعوة والشؤون الإسلامية',
  'Other / Cross-sectoral': 'أخرى / متعدد القطاعات',
};

const NEED_THEME: Record<string, string> = {
  'Distance to facility': 'المسافة إلى المرفق',
  'Transport availability': 'توفر وسائل النقل',
  'Service not available': 'عدم توفر الخدمة',
  'Service quality': 'جودة الخدمة',
  'Staffing shortage': 'نقص الكوادر',
  'Supply or stock shortage': 'نقص الإمدادات أو المخزون',
  'Affordability and cost': 'القدرة على تحمل التكلفة',
  'Water availability': 'توفر المياه',
  'Water quality': 'جودة المياه',
  'Sanitation and hygiene': 'الصرف الصحي والنظافة',
  'Electricity and energy': 'الكهرباء والطاقة',
  'Road and connectivity': 'الطرق ووسائل الربط',
  'Digital connectivity': 'الاتصال الرقمي',
  'School access and dropout': 'الالتحاق بالمدرسة والتسرب منها',
  'Learning materials': 'المواد التعليمية',
  'Skills and employability': 'المهارات وقابلية التوظيف',
  'Income and livelihood': 'الدخل وسبل العيش',
  'Market access': 'الوصول إلى الأسواق',
  'Awareness and information': 'التوعية والمعلومات',
  'Participation and voice': 'المشاركة وإيصال الصوت',
  'Women and girls': 'النساء والفتيات',
  'Children and youth': 'الأطفال والشباب',
  'Elderly and disability': 'كبار السن وذوي الاعاقة',
  'Safety and risk': 'السلامة والمخاطر',
  'Heritage and culture': 'التراث والثقافة',
};

const DECISION_TYPE: Record<string, string> = {
  Intervention: 'تدخل',
  Escalation: 'تصعيد',
  'Follow-up': 'متابعة',
};

const GAP_TYPE: Record<string, string> = {
  acute: 'حادة',
  'Conflict-related': 'متعلقة بالنزاع',
  chronic: 'مزمنة',
  structural: 'هيكلية',
  seasonal: 'موسمية',
  equity: 'الإنصاف والمساواة',
};

async function applyMap(
  label: string,
  delegate: { updateMany: (args: { where: { name: string }; data: { nameAr: string } }) => Promise<{ count: number }> },
  map: Record<string, string>,
) {
  let updated = 0;
  for (const [name, nameAr] of Object.entries(map)) {
    const result = await delegate.updateMany({ where: { name }, data: { nameAr } });
    if (result.count === 0) {
      console.warn(`${label}: no row found for English name "${name}" — check for a wording drift vs. the DB.`);
    }
    updated += result.count;
  }
  console.log(`${label}: updated ${updated}/${Object.keys(map).length} rows.`);
}

async function main() {
  await applyMap('Study Type', prisma.studyTypeOption, STUDY_TYPE);
  await applyMap('Target Sector', prisma.targetSectorOption, TARGET_SECTOR);
  await applyMap('Need Theme', prisma.needThemeOption, NEED_THEME);
  await applyMap('Decision Type', prisma.decisionTypeOption, DECISION_TYPE);
  await applyMap('Gap Type', prisma.gapTypeOption, GAP_TYPE);
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
