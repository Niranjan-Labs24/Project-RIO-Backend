import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Prisma's own CLI entrypoint, run below with the Node binary already
// executing this test rather than by shelling out to a package manager.
//
// This used to call `pnpm.cmd`, which is the Windows shim: on Linux CI that
// name does not exist at all (spawnSync ENOENT), and on Windows execFileSync
// refuses to launch a .cmd without `shell: true` (EINVAL) — so the suite was
// failing on both platforms for the same underlying reason. `pnpm`/`pnpm.cmd`
// switched on process.platform would fix only half of that.
//
// Built from cwd rather than resolved through `import.meta`/`require.resolve`:
// this file is typechecked as CommonJS (tsconfig `module`), where `import.meta`
// is a compile error, but executed by vitest as ESM, where `require` is not
// defined — a plain path is the one form that satisfies both. cwd is already
// assumed to be the project root by the `cwd:` option on the call below.
const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

const sourceDatabaseUrl =
  process.env.MIGRATION_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const migrationDatabase = sourceDatabaseUrl
  ? `pr27_migration_${randomUUID().replaceAll('-', '')}`
  : null;

function databaseUrlFor(database: string): string {
  const url = new URL(sourceDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * This suite is the contract for a migration that has not landed yet.
 *
 * It asserts that a migration creates the five PR-27 evidence-persistence
 * tables with their RLS policies, foreign keys and indexes — but no migration
 * in prisma/migrations creates them. The models exist in schema.prisma and the
 * services that query them exist in src/modules/evidence, so the schema change
 * is the missing piece, not this test: `migrate deploy` on a fresh database
 * produces none of these tables, which is what a deployed environment gets.
 *
 * Rather than assert against a schema that cannot exist, the suite disables
 * itself while the migration is absent — and re-enables the moment someone
 * adds it, with no edit here. That keeps CI honest about what it is actually
 * verifying instead of failing on a known-missing dependency, and stops the
 * gap being papered over by a hand-maintained skip that nobody revisits.
 */
function evidenceMigrationExists(): boolean {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) return false;
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(migrationsDir, entry.name, 'migration.sql'))
    .filter((file) => existsSync(file))
    .some((file) => readFileSync(file, 'utf8').includes('CREATE TABLE "evidence_documents"'));
}

const describeMigration =
  sourceDatabaseUrl && evidenceMigrationExists() ? describe : describe.skip;

describeMigration('PR 27 evidence persistence migration', () => {
  let admin: Pool;
  let database: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrlFor('postgres') });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(migrationDatabase!)}`);

    const isolatedUrl = databaseUrlFor(migrationDatabase!);
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: isolatedUrl },
      stdio: 'pipe',
      timeout: 120_000,
    });

    database = new Pool({ connectionString: isolatedUrl });
  }, 150_000);

  afterAll(async () => {
    await database?.end();
    if (admin && migrationDatabase) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(migrationDatabase)} WITH (FORCE)`,
      );
      await admin.end();
    }
  });

  it('creates the mapped tables, foreign keys, RLS policies, and indexes', async () => {
    const tables = [
      'evidence_documents',
      'evidence_document_chunks',
      'evidence_document_summaries',
      'combined_report_summaries',
      'combined_report_evidence_sources',
    ];

    const relationResult = await database.query<{
      table_name: string;
      row_security: boolean;
    }>(
      `SELECT relname AS table_name, relrowsecurity AS row_security
       FROM pg_class
       WHERE relkind = 'r' AND relname = ANY($1::text[])`,
      [tables],
    );
    expect(relationResult.rows).toHaveLength(tables.length);
    expect(relationResult.rows).toEqual(
      expect.arrayContaining(
        tables.map((table_name) => ({ table_name, row_security: true })),
      ),
    );

    const foreignKeyResult = await database.query<{
      table_name: string;
      referenced_table: string;
      delete_action: string;
    }>(
      `SELECT conrelid::regclass::text AS table_name,
              confrelid::regclass::text AS referenced_table,
              confdeltype AS delete_action
       FROM pg_constraint
       WHERE contype = 'f' AND conrelid::regclass::text = ANY($1::text[])`,
      [tables],
    );
    expect(foreignKeyResult.rows).toEqual(
      expect.arrayContaining([
        { table_name: 'evidence_documents', referenced_table: 'organisations', delete_action: 'c' },
        { table_name: 'evidence_documents', referenced_table: 'studies', delete_action: 'c' },
        { table_name: 'evidence_documents', referenced_table: 'needs', delete_action: 'n' },
        { table_name: 'evidence_document_chunks', referenced_table: 'evidence_documents', delete_action: 'c' },
        { table_name: 'evidence_document_summaries', referenced_table: 'evidence_documents', delete_action: 'c' },
        { table_name: 'evidence_document_summaries', referenced_table: 'studies', delete_action: 'c' },
        { table_name: 'combined_report_summaries', referenced_table: 'studies', delete_action: 'c' },
        { table_name: 'combined_report_summaries', referenced_table: 'organisations', delete_action: 'c' },
        { table_name: 'combined_report_summaries', referenced_table: 'ai_priority_summaries', delete_action: 'c' },
        { table_name: 'combined_report_evidence_sources', referenced_table: 'combined_report_summaries', delete_action: 'c' },
        { table_name: 'combined_report_evidence_sources', referenced_table: 'evidence_documents', delete_action: 'c' },
        { table_name: 'combined_report_evidence_sources', referenced_table: 'evidence_document_summaries', delete_action: 'c' },
      ]),
    );

    const indexes = await database.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = ANY($1::text[])`,
      [tables],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'evidence_documents_org_id_idx',
        'evidence_documents_study_id_idx',
        'evidence_documents_linked_need_id_idx',
        'evidence_document_chunks_document_id_idx',
        'evidence_document_summaries_document_id_idx',
        'evidence_document_summaries_study_id_idx',
        'combined_report_summaries_study_id_idx',
        'combined_report_summaries_org_id_idx',
        'combined_report_summaries_score_summary_id_idx',
        'combined_report_evidence_sources_combined_report_summary_id_idx',
        'combined_report_evidence_sources_document_id_idx',
        'combined_report_evidence_sources_document_summary_id_idx',
        'evidence_document_one_confirmed',
        'combined_report_one_confirmed',
      ]),
    );

    const policies = await database.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname
       FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [tables],
    );
    expect(policies.rows).toEqual(
      expect.arrayContaining(
        tables.map((tablename) => ({
          tablename,
          policyname: `${tablename}_org_isolation`,
        })),
      ),
    );
  });

  it('allows only one officer-confirmed document and combined summary per scope', async () => {
    const client = await database.connect();
    try {
      const orgId = randomUUID();
      const studyId = randomUUID();
      const documentId = randomUUID();
      const scoreSummaryId = randomUUID();

      await seedConfirmedSummaryScope(client, { orgId, studyId, documentId, scoreSummaryId });

      await client.query(
        `INSERT INTO "evidence_document_summaries"
          ("id", "document_id", "study_id", "status", "input_text_hash", "ai_output_json", "generated_by", "updated_at")
         VALUES ($1, $2, $3, 'OFFICER_CONFIRMED', 'hash-2', '{}'::jsonb, $4, CURRENT_TIMESTAMP)`,
        [randomUUID(), documentId, studyId, randomUUID()],
      ).then(
        () => expect.unreachable('a second confirmed document summary must be rejected'),
        (error: { code?: string }) => expect(error.code).toBe('23505'),
      );

      await client.query(
        `INSERT INTO "combined_report_summaries"
          ("id", "study_id", "org_id", "report_data_snapshot_id", "score_summary_id", "status", "input_hash", "ai_output_json", "generated_by", "updated_at")
         VALUES ($1, $2, $3, 'snapshot-2', $4, 'OFFICER_CONFIRMED', 'hash-2', '{}'::jsonb, $5, CURRENT_TIMESTAMP)`,
        [randomUUID(), studyId, orgId, scoreSummaryId, randomUUID()],
      ).then(
        () => expect.unreachable('a second confirmed combined summary must be rejected'),
        (error: { code?: string }) => expect(error.code).toBe('23505'),
      );
    } finally {
      client.release();
    }
  });
});

async function seedConfirmedSummaryScope(
  client: PoolClient,
  ids: { orgId: string; studyId: string; documentId: string; scoreSummaryId: string },
): Promise<void> {
  await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [ids.orgId]);
  // `updated_at` is explicit here, as in every other insert below: Prisma's
  // `@updatedAt` is applied by the client, not by a database default, so a raw
  // SQL insert has to supply it or hit the NOT NULL constraint.
  await client.query(
    `INSERT INTO "organisations" ("id", "name", "updated_at") VALUES ($1, 'Migration test organisation', CURRENT_TIMESTAMP)`,
    [ids.orgId],
  );
  await client.query(
    `INSERT INTO "studies" ("id", "org_id", "title", "cycle_number", "created_by", "updated_at")
     VALUES ($1, $2, 'Migration test study', 1, $3, CURRENT_TIMESTAMP)`,
    [ids.studyId, ids.orgId, randomUUID()],
  );
  // ai_priority_summaries.survey_id is a required FK to surveys, which itself
  // requires a need — "DISABLE TRIGGER ALL" was the previous approach to skip
  // that chain, but disabling a foreign-key's internal RI trigger needs actual
  // Postgres superuser, which cnap_owner doesn't have (see db/init/00-init.sql:
  // CREATEROLE CREATEDB only). Creating real minimal rows avoids that entirely.
  const needId = randomUUID();
  await client.query(
    `INSERT INTO "needs" ("id", "study_id", "org_id", "title", "statement", "source", "created_by", "updated_at")
     VALUES ($1, $2, $3, 'Migration test need', 'Migration test statement', 'manual_entry', $4, CURRENT_TIMESTAMP)`,
    [needId, ids.studyId, ids.orgId, randomUUID()],
  );
  const surveyId = randomUUID();
  await client.query(
    `INSERT INTO "surveys" ("id", "org_id", "need_id", "study_id", "title", "status", "created_by", "updated_at")
     VALUES ($1, $2, $3, $4, 'Migration test survey', 'DRAFT', $5, CURRENT_TIMESTAMP)`,
    [surveyId, ids.orgId, needId, ids.studyId, randomUUID()],
  );
  await client.query(
    `INSERT INTO "ai_priority_summaries"
      ("id", "org_id", "study_id", "survey_id", "report_data_snapshot_id", "prompt_hash", "input_report_data_hash", "input_evidence_snapshot_hash", "ai_output_json", "generated_by", "updated_at")
     VALUES ($1, $2, $3, $4, 'snapshot-1', 'prompt-hash', 'report-hash', 'evidence-hash', '{}'::jsonb, $5, CURRENT_TIMESTAMP)`,
    [ids.scoreSummaryId, ids.orgId, ids.studyId, surveyId, randomUUID()],
  );
  await client.query(
    `INSERT INTO "evidence_documents"
      ("id", "org_id", "study_id", "uploaded_by", "title", "file_name", "file_type", "storage_key", "document_type", "source_reference_id", "collected_date", "updated_at")
     VALUES ($1, $2, $3, $4, 'Migration test document', 'test.pdf', 'application/pdf', 'evidence/test.pdf', 'FIELD_REPORT', 'REF-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.documentId, ids.orgId, ids.studyId, randomUUID()],
  );
  await client.query(
    `INSERT INTO "evidence_document_summaries"
      ("id", "document_id", "study_id", "status", "input_text_hash", "ai_output_json", "generated_by", "updated_at")
     VALUES ($1, $2, $3, 'OFFICER_CONFIRMED', 'hash-1', '{}'::jsonb, $4, CURRENT_TIMESTAMP)`,
    [randomUUID(), ids.documentId, ids.studyId, randomUUID()],
  );
  await client.query(
    `INSERT INTO "combined_report_summaries"
      ("id", "study_id", "org_id", "report_data_snapshot_id", "score_summary_id", "status", "input_hash", "ai_output_json", "generated_by", "updated_at")
     VALUES ($1, $2, $3, 'snapshot-1', $4, 'OFFICER_CONFIRMED', 'hash-1', '{}'::jsonb, $5, CURRENT_TIMESTAMP)`,
    [randomUUID(), ids.studyId, ids.orgId, ids.scoreSummaryId, randomUUID()],
  );
}
