import 'dotenv/config';
import { Client, Pool, type PoolClient } from 'pg';
import { pgSslFromEnv } from '../src/prisma/pg-ssl';

// Cross-tenant isolation for EVERY tenant table, not just `users`.
//
// For each table whose rows are keyed by an org column and protected by row-level security,
// a connection acting as one organization (cnap_app, NOBYPASSRLS, app.current_org_id set)
// must be unable to read, update, delete or insert rows that belong to the other one, and a
// connection with no org context must see nothing. Every statement runs in a transaction that
// is rolled back, so the suite changes no data and can be re-run.
//
// Tables whose policy deliberately spans two organizations (a sharing request is visible to
// both parties) are excluded by policy shape, not by name.

const ORG_COLUMNS = ['org_id', 'organisation_id'] as const;

// Tables that carry an org column but are deliberately NOT in the loop below. This list is a
// reviewed decision, kept here on purpose instead of being derived from the database: if a new
// table gets an org column but no row-level security (or a policy that reaches across
// organizations), it is not in the loop AND not in this list, so the suite fails until a
// person looks at it.
const REVIEWED_EXCLUSIONS: Record<string, string> = {
  // Policy is `org_id = current org OR open_to_other_entities = true`: visible across entities by design.
  initiatives: 'shared across entities when open_to_other_entities is set',
  // Platform-wide operational log, System Admin only; no tenant RLS by design.
  system_logs: 'platform log, no row-level security by design',
};

interface TenantTable {
  table: string;
  column: (typeof ORG_COLUMNS)[number];
}

describe('Cross-tenant isolation (RLS) - every tenant table', () => {
  let app: Pool;
  let owner: Pool;
  let tables: TenantTable[] = [];
  let orgA = '';
  let orgB = '';
  let rejectedInserts = 0;
  let orgKeyedTables: string[] = [];

  beforeAll(async () => {
    app = new Pool({ connectionString: process.env.APP_DATABASE_URL, ssl: pgSslFromEnv() });
    owner = new Pool({ connectionString: process.env.DATABASE_URL, ssl: pgSslFromEnv() });

    // `organisations` itself is RLS-protected (organisations_isolation: id = current_org_id),
    // and RLS is FORCED — even the owner role can't see any row without app.current_org_id
    // already set, which is exactly what this query is trying to discover. cnap_supervisor's
    // own policy (organisations_supervisor_read: USING (true)) is the one role allowed to read
    // across all organisations, so it — not the owner connection — is used for this one
    // bootstrapping read only; every other query below still goes through asOrg()'s per-org
    // context, same as before.
    const supervisor = new Pool({
      connectionString: process.env.SUPERVISOR_DATABASE_URL,
      ssl: pgSslFromEnv(),
    });
    const orgs = await supervisor.query<{ id: string }>(
      `SELECT id FROM organisations ORDER BY created_at LIMIT 2`,
    );
    await supervisor.end();
    if (orgs.rows.length < 2) throw new Error('Run `pnpm seed:demo` first (two organisations are required).');
    orgA = orgs.rows[0]!.id;
    orgB = orgs.rows[1]!.id;

    const found = await owner.query<{ table_name: string; column_name: string; qual: string | null }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              (SELECT string_agg(p.qual, ' ') FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname AND ('cnap_app' = ANY (p.roles) OR 'public' = ANY (p.roles))) AS qual
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = ANY ($1) AND NOT a.attisdropped
        WHERE c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
        ORDER BY c.relname`,
      [ORG_COLUMNS as unknown as string[]],
    );
    // Every table with an org column, whatever its RLS state: the independent inventory.
    const everyOrgKeyed = await owner.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = ANY ($1) AND NOT a.attisdropped
        WHERE c.relkind = 'r'
        ORDER BY c.relname`,
      [ORG_COLUMNS as unknown as string[]],
    );
    orgKeyedTables = everyOrgKeyed.rows.map((r) => r.table_name);
    tables = found.rows
      .filter((r) => r.qual && !/\bOR\b/i.test(r.qual) && r.qual.includes(r.column_name))
      .map((r) => ({ table: r.table_name, column: r.column_name as TenantTable['column'] }));
  });

  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  async function asOrg<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  it('discovers a meaningful set of tenant tables (guards against the query silently matching nothing)', () => {
    expect(tables.length).toBeGreaterThanOrEqual(40);
    expect(tables.map((t) => t.table)).toEqual(expect.arrayContaining(['users', 'studies', 'needs', 'surveys']));
  });

  it('leaves out only the reviewed exceptions: every other org-keyed table is under test', () => {
    const tested = new Set(tables.map((t) => t.table));
    const unaccounted = orgKeyedTables.filter((t) => !tested.has(t) && !(t in REVIEWED_EXCLUSIONS));
    // A table listed here has an org column but no forced row-level security (or a policy that
    // spans organizations). Fix its policy, or add it to REVIEWED_EXCLUSIONS with a reason.
    expect(unaccounted).toEqual([]);
    // And the exceptions must still exist and still be exceptions, so the list cannot go stale.
    const stale = Object.keys(REVIEWED_EXCLUSIONS).filter((t) => !orgKeyedTables.includes(t) || tested.has(t));
    expect(stale).toEqual([]);
  });

  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ] as const)('org %s cannot read, update, delete or insert org %s\'s rows in any tenant table', async (me, other) => {
    const mine = me === 'A' ? orgA : orgB;
    const theirs = other === 'A' ? orgA : orgB;
    const failures: string[] = [];

    for (const { table, column } of tables) {
      await asOrg(mine, async (client) => {
        const read = await client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [theirs]);
        if (read.rows[0].n !== 0) failures.push(`${table}: read ${read.rows[0].n} foreign rows`);

        // Some tables are append-only for the app role (no UPDATE/DELETE grant): a permission
        // error (42501) is isolation too. Anything that succeeds must have touched 0 rows.
        for (const [verb, sql] of [
          ['updated', `UPDATE "${table}" SET "${column}" = "${column}" WHERE "${column}" = $1`],
          ['deleted', `DELETE FROM "${table}" WHERE "${column}" = $1`],
        ] as const) {
          await client.query('SAVEPOINT write_attempt');
          try {
            const res = await client.query(sql, [theirs]);
            if (res.rowCount !== 0) failures.push(`${table}: ${verb} ${res.rowCount} foreign rows`);
          } catch (err) {
            if ((err as { code?: string }).code !== '42501') throw err;
            await client.query('ROLLBACK TO SAVEPOINT write_attempt');
          }
        }
      });

      // Insert: clone one of my own rows but re-key it to the other organization. The row-level
      // policy's WITH CHECK must reject it (42501) - unless my org has no row to clone.
      await asOrg(mine, async (client) => {
        const own = await client.query(`SELECT 1 FROM "${table}" WHERE "${column}" = $1 LIMIT 1`, [mine]);
        if (own.rowCount === 0) return;
        await client.query('SAVEPOINT attempt');
        try {
          await client.query(
            `INSERT INTO "${table}"
             SELECT (jsonb_populate_record(NULL::"${table}", to_jsonb(r) || jsonb_build_object('${column}', $2::text))).*
               FROM "${table}" r WHERE r."${column}" = $1 LIMIT 1`,
            [mine, theirs],
          );
          failures.push(`${table}: inserted a row for the other organization`);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // 42501 = row-level security violation. Any other error means the statement was
          // not a valid clone for this table, so it proves nothing either way.
          if (code === '42501') rejectedInserts++;
        }
      });
    }

    expect(failures).toEqual([]);
  });

  it('actually exercised the insert check on many tables (the suite is not passing vacuously)', () => {
    // 28 tables were rejected when this was written; a floor of 25 catches a large silent drop.
    expect(rejectedInserts).toBeGreaterThanOrEqual(25);
  });

  it('on a connection that never had an organization set, no tenant table returns a row', async () => {
    // A brand-new connection (never pooled, never used for a request): the setting is absent.
    const virgin = new Client({ connectionString: process.env.APP_DATABASE_URL, ssl: pgSslFromEnv() });
    await virgin.connect();
    try {
      const leaks: string[] = [];
      for (const { table } of tables) {
        const res = await virgin.query(`SELECT count(*)::int AS n FROM "${table}"`);
        if (res.rows[0].n !== 0) leaks.push(`${table}: ${res.rows[0].n} rows visible without context`);
      }
      expect(leaks).toEqual([]);
    } finally {
      await virgin.end();
    }
  });

  // A pooled connection that previously ran a request keeps the setting as an empty string
  // (transaction-local settings reset to '' on commit, not to "unset"). Every policy must then
  // still return zero rows. ai_priority_summaries' policy casts the empty string to uuid without
  // NULLIF and raises instead - still no data, but inconsistent with the rest. Tracked in the
  // audit (fixing it needs a migration); listed here so the suite fails if any OTHER table
  // starts behaving that way, and so this entry is removed once the policy is fixed.
  const KNOWN_ERRORS_ON_EMPTY_SETTING = ['ai_priority_summaries'];

  it('on a reused connection (setting is an empty string), no tenant table returns a row', async () => {
    const leaks: string[] = [];
    const erroring: string[] = [];
    for (const { table } of tables) {
      const client = await app.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
        await client.query('COMMIT'); // the setting now reads as ''
        try {
          const res = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
          if (res.rows[0].n !== 0) leaks.push(`${table}: ${res.rows[0].n} rows visible on a reused connection`);
        } catch (err) {
          if ((err as { code?: string }).code === '22P02') erroring.push(table);
          else throw err;
        }
      } finally {
        client.release();
      }
    }
    expect(leaks).toEqual([]);
    expect(erroring).toEqual(KNOWN_ERRORS_ON_EMPTY_SETTING);
  });
});
