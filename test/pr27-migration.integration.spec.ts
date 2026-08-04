import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const describeMigration = sourceDatabaseUrl ? describe : describe.skip;

describeMigration('PR 27 evidence persistence migration', () => {
  let admin: Pool;
  let database: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrlFor('postgres') });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(migrationDatabase!)}`);

    const isolatedUrl = databaseUrlFor(migrationDatabase!);
    execFileSync('pnpm.cmd', ['exec', 'prisma', 'migrate', 'deploy'], {
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
  await client.query(`INSERT INTO "organisations" ("id", "name") VALUES ($1, 'Migration test organisation')`, [ids.orgId]);
  await client.query(
    `INSERT INTO "studies" ("id", "org_id", "title", "cycle_number", "created_by", "updated_at")
     VALUES ($1, $2, 'Migration test study', 1, $3, CURRENT_TIMESTAMP)`,
    [ids.studyId, ids.orgId, randomUUID()],
  );
  await client.query(`ALTER TABLE "ai_priority_summaries" DISABLE TRIGGER ALL`);
  await client.query(
    `INSERT INTO "ai_priority_summaries"
      ("id", "org_id", "study_id", "survey_id", "report_data_snapshot_id", "prompt_hash", "input_report_data_hash", "input_evidence_snapshot_hash", "ai_output_json", "generated_by", "updated_at")
     VALUES ($1, $2, $3, $4, 'snapshot-1', 'prompt-hash', 'report-hash', 'evidence-hash', '{}'::jsonb, $5, CURRENT_TIMESTAMP)`,
    [ids.scoreSummaryId, ids.orgId, ids.studyId, randomUUID(), randomUUID()],
  );
  await client.query(`ALTER TABLE "ai_priority_summaries" ENABLE TRIGGER ALL`);
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
