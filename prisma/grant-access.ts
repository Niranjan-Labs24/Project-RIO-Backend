import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not defined in the environment.");
  process.exit(1);
}

async function main() {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log("Applying PostgreSQL security grants to cnap_app and cnap_supervisor...");

  try {
    // Grant permissions on new tables to the app role
    await prisma.$executeRawUnsafe('GRANT SELECT ON "questions" TO cnap_app;');
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_suggestions", "human_decisions", "surveys", "survey_questions", "survey_responses" TO cnap_app;');
    
    // Grant permission on new tables to the supervisor role
    await prisma.$executeRawUnsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO cnap_supervisor;');
    
    console.log("Database grants successfully verified and applied!");
  } catch (err) {
    console.error("Error applying SQL grants:", err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
