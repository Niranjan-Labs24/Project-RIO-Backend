import { Pool } from 'pg';

async function run() {
  const poolOwner = new Pool({
    connectionString: 'postgresql://cnap_owner:cnap_owner_dev_pw@localhost:5433/cnap',
    ssl: false,
  });

  console.log('Granting permissions via owner...');
  await poolOwner.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cnap_supervisor`);
  await poolOwner.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cnap_supervisor`);
  await poolOwner.end();

  const poolSupervisor = new Pool({
    connectionString: 'postgresql://cnap_supervisor:cnap_supervisor_dev_pw@localhost:5433/cnap',
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
