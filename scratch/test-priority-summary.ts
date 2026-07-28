import * as dotenv from 'dotenv';
dotenv.config();

import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';

async function test() {
  const tenant = new TenantPrismaService();

  try {
    console.log('Testing DB connection...');
    await tenant.runInOrgContext(async (tx) => {
      const need = await tx.need.findFirst({
        where: { title: { contains: 'Irregular drinking water' } },
        include: { surveys: true },
      });

      console.log('Need found:', need?.id, need?.title);
      if (!need || !need.surveys || need.surveys.length === 0) {
        console.log('No survey found for need');
        return;
      }

      const survey = need.surveys[0];
      if (!survey) return;
      console.log('Survey found:', survey.id, survey.status);

      const studyId = survey.studyId;
      const surveyId = survey.id;

      const rollups = await tx.scoreRollup.findMany({
        where: { studyId, surveyId },
      });
      console.log('Rollups count:', rollups.length);

      const priorityAssessment = await tx.villagePriorityAssessment.findFirst({
        where: { studyId, surveyId },
      });
      console.log('Priority Assessment found:', !!priorityAssessment);
      if (priorityAssessment) {
        console.log('Priority Score:', priorityAssessment.priorityScore, priorityAssessment.priorityStatus);
      }
    });
  } catch (err: any) {
    console.error('Test Error:', err);
  }
}

test();
