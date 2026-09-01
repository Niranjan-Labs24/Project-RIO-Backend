import 'dotenv/config';
import { runMigrations } from 'graphile-worker';

// GAP-04 schema bootstrap. graphile-worker owns the `graphile_worker` schema
// (its jobs tables + the add_job function). That schema MUST exist before the
// hand-authored grant migration 20260824160000_graphile_worker_grants runs
// (the grants/policies reference graphile_worker._private_* and add_job) AND
// before the app enqueues anything.
//
// The in-process runner (JobsWorkerService) also installs it on boot via the
// owner connection, so at RUNTIME this is self-healing. But `prisma migrate
// deploy` runs at BUILD/DEPLOY time, before the app boots — so on a fresh
// database this bootstrap must run FIRST:
//
//     pnpm gw:bootstrap && pnpm prisma:deploy
//
// Uses the OWNER connection (DATABASE_URL = cnap_owner): installing the schema
// creates tables/functions and needs DDL privileges. Idempotent — re-running
// only applies graphile-worker migrations not yet present.
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL (owner) is not defined in the environment.');
    process.exit(1);
  }
  await runMigrations({ connectionString });
  console.log('graphile-worker schema installed/migrated (owner connection).');
  process.exit(0);
}

main().catch((err) => {
  console.error('graphile-worker bootstrap failed:', err);
  process.exit(1);
});
