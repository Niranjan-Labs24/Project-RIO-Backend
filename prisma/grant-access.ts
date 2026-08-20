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
    // Read-only reference data. "nic_registry" is granted by its own migration
    // too; it is repeated here because this script is what repairs a database
    // whose grants have drifted (a db push or a manual table recreate drops the
    // ACL the migration set), and a table missing from this list stays broken.
    await prisma.$executeRawUnsafe('GRANT SELECT ON "questions", "nic_registry" TO cnap_app;');
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_priority_summaries", "ai_suggestions", "human_decisions", "surveys", "survey_questions", "survey_responses" TO cnap_app;');
    await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON "ncnp_report_reviews" TO cnap_app;');
    await prisma.$executeRawUnsafe('ALTER TABLE "ai_priority_summaries" ENABLE ROW LEVEL SECURITY;');
    await prisma.$executeRawUnsafe('DROP POLICY IF EXISTS ai_priority_summaries_tenant_isolation ON "ai_priority_summaries";');
    await prisma.$executeRawUnsafe('CREATE POLICY ai_priority_summaries_tenant_isolation ON "ai_priority_summaries" USING (org_id = current_setting(\'app.current_org_id\', true)::uuid);');
    
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
