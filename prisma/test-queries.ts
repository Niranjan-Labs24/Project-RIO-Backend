import { PrismaClient } from '../src/generated/prisma';

const prisma = new PrismaClient();

async function main() {
  console.log('Testing database models query access...');
  
  const questions = await prisma.question.findMany({ take: 2 });
  console.log('Question Model Access: SUCCESS. Seeded questions count:', questions.length);

  const suggestions = await prisma.aiSuggestion.findMany({ take: 1 });
  console.log('AiSuggestion Model Access: SUCCESS.');

  const decisions = await prisma.humanDecision.findMany({ take: 1 });
  console.log('HumanDecision Model Access: SUCCESS.');

  const surveys = await prisma.survey.findMany({ take: 1 });
  console.log('Survey Model Access: SUCCESS.');

  console.log('All DB model schema validations and query access tests PASSED successfully!');
}

main()
  .catch((e) => {
    console.error('Test script failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
