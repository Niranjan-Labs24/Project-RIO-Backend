import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20260727150000_fix_study_archive_column_types',
  'migration.sql',
);

describe('study archive migration', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  it('creates every Study archive column with the Prisma schema types', () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "status" VARCHAR\(50\) NOT NULL DEFAULT 'active'/,
    );
    expect(sql).toMatch(/ALTER COLUMN "archived_by" TYPE UUID/);
    expect(sql).toMatch(
      /ALTER COLUMN "archive_reason" TYPE VARCHAR\(500\)/,
    );
  });
});
