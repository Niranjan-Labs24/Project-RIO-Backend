import 'dotenv/config';
import { Pool } from 'pg';

// Connection strings come from the environment (.env), never from the source.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .env.example)`);
  return value;
}

async function run() {
  const poolOwner = new Pool({
    connectionString: requireEnv('DATABASE_URL'),
    ssl: false,
  });

  console.log('Granting permissions via owner...');
  await poolOwner.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cnap_supervisor`);
  await poolOwner.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cnap_supervisor`);
  await poolOwner.end();

  const poolSupervisor = new Pool({
    connectionString: requireEnv('SUPERVISOR_DATABASE_URL'),
    ssl: false,
  });

  console.log('Activating all organizations and users via supervisor...');
  const resOrgs = await poolSupervisor.query(`UPDATE organisations SET is_active = true`);
  console.log(`Successfully activated ${resOrgs.rowCount} organization(s) in DB!`);

  const resUsers = await poolSupervisor.query(`UPDATE users SET status = 'active' WHERE status = 'disabled'`);
  console.log(`Successfully re-activated ${resUsers.rowCount} user(s) in DB!`);

  await poolSupervisor.end();
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
