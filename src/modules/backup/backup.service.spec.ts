import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { BackupService } from './backup.service';
import * as archiveUtil from './attachment-archive.util';
import * as pgDumpUtil from './pg-dump.util';
import type { ConfigService } from '../../config/config.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemLogsService } from '../system-logs/system-logs.service';
import type { MailerService } from '../../mailer/mailer.service';

vi.mock('./pg-dump.util', () => ({
  runPgDump: vi.fn(),
}));
vi.mock('./attachment-archive.util', () => ({
  archiveAttachments: vi.fn(),
  hashFile: vi.fn(async () => 'a'.repeat(64)),
}));

function fakeConfig(
  overrides: Partial<{
    databaseUrl: string;
    backupDir: string;
    backupCronSchedule: string;
    backupDatabaseUrl: string | undefined;
    backupRetentionCron: string;
    backupRetentionDays: number;
    evidenceStoragePath: string;
    pgDumpPath: string | undefined;
  }> = {},
): ConfigService {
  return {
    databaseUrl: 'postgresql://cnap_owner:cnap_owner_dev_pw@localhost:5432/cnap',
    backupDir: './storage/backups',
    backupCronSchedule: '0 */2 * * *',
    // pg_dump needs a BYPASSRLS role; see BACKUP_DATABASE_URL.
    backupDatabaseUrl: 'postgresql://cnap_backup:pw@localhost:5432/cnap',
    backupRetentionCron: '30 4 * * *',
    backupRetentionDays: 30,
    evidenceStoragePath: './storage/evidence',
    pgDumpPath: undefined,
    ...overrides,
  } as unknown as ConfigService;
}

function fakeSchedulerRegistry(): SchedulerRegistry {
  return { addCronJob: vi.fn() } as unknown as SchedulerRegistry;
}

/** Captures what was written to `backup_runs`, which is AC 2's whole point. */
function fakePrisma(
  seed: { rows?: Record<string, unknown>[]; uncoveredTables?: string[] } = {},
) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const rows = seed.rows ?? [];
  return {
    captured: { created, updated },
    prisma: {
      // The coverage gate's catalogue query: which RLS tables lack a
      // cnap_backup read policy. Empty means every table is covered.
      $queryRaw: vi.fn(async () =>
        (seed.uncoveredTables ?? []).map((relname) => ({ relname })),
      ),
      user: { findMany: vi.fn(async () => [{ email: 'admin@platform.local' }]) },
      backupRun: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `run-${created.length}` };
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return {};
        }),
        findFirst: vi.fn(async () => rows[0] ?? null),
        findMany: vi.fn(async () => rows.slice(1)),
        findUnique: vi.fn(async () => rows[0] ?? null),
      },
    } as unknown as PrismaService,
  };
}

function fakeSystemLog() {
  return { record: vi.fn() } as unknown as SystemLogsService;
}

/**
 * A destination that reports back whatever it was handed. Unit tests never
 * write real files, and the real LocalFilesystemDestination stats what it
 * stores — which is correct behaviour, and the reason this is injected.
 */
function fakeDestination(over: { sizeBytes?: number; encrypted?: boolean } = {}) {
  return {
    name: 'test',
    encrypts: over.encrypted ?? false,
    store: vi.fn(async (localPath: string) => ({
      location: localPath,
      sizeBytes: over.sizeBytes ?? 4096,
      encrypted: over.encrypted ?? false,
    })),
  };
}

function fakeMailer() {
  return { sendBackupFailureAlert: vi.fn(async () => true) } as unknown as MailerService;
}

describe('BackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers both the backup and the retention job on init', () => {
    const scheduler = fakeSchedulerRegistry();
    const { prisma } = fakePrisma();
    const service = new BackupService(
      fakeConfig({ backupCronSchedule: '0 */2 * * *' }),
      scheduler,
      prisma,
      fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    service.onModuleInit();

    // Retention has its OWN schedule on purpose: a period with no backups is
    // exactly when disk pressure builds, so pruning must not stop with them.
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(2);
    expect(scheduler.addCronJob).toHaveBeenCalledWith('database-backup', expect.anything());
    expect(scheduler.addCronJob).toHaveBeenCalledWith('backup-retention', expect.anything());
  });

  it('records a run row BEFORE doing any work, so a killed process leaves evidence', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/app/storage/backups/x.dump',
      fileName: 'x.dump',
      sizeBytes: 4096,
    });
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    await service.run('database', 'schedule');

    expect(captured.created[0]).toMatchObject({
      kind: 'database',
      status: 'running',
      trigger: 'schedule',
      triggeredBy: null,
    });
    expect(captured.created[0]!.retainUntil).toBeInstanceOf(Date);
  });

  it('records a checksum on success — what makes a backup verifiable later', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/app/storage/backups/x.dump',
      fileName: 'x.dump',
      sizeBytes: 4096,
    });
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    const result = await service.run('database', 'schedule');

    expect(result.success).toBe(true);
    expect(result.sha256).toHaveLength(64);
    expect(captured.updated[0]).toMatchObject({
      status: 'succeeded',
      fileName: 'x.dump',
      sha256: 'a'.repeat(64),
    });
  });

  it('treats an empty dump as a failure', async () => {
    // pg_dump exiting 0 having written nothing is not a success, and finding
    // that out during a restore is finding out too late.
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/app/storage/backups/empty.dump',
      fileName: 'empty.dump',
      sizeBytes: 0,
    });
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    const result = await service.run('database', 'schedule');

    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
    expect(captured.updated[0]).toMatchObject({ status: 'failed' });
  });

  it('never throws on failure, and writes the failure to the run row and the system log', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockRejectedValue(new Error('spawn pg_dump ENOENT'));
    const { prisma, captured } = fakePrisma();
    const systemLog = fakeSystemLog();
    const service = new BackupService(fakeConfig(), fakeSchedulerRegistry(), prisma, systemLog, fakeMailer(), fakeDestination());

    const result = await service.run('database', 'schedule');

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(captured.updated[0]).toMatchObject({ status: 'failed' });
    expect((captured.updated[0] as { error: string }).error).toContain('ENOENT');
    // A silent failed backup is the exact failure this ticket exists to
    // prevent, so it has to reach the operational log too.
    expect(systemLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', eventCode: 'BACKUP_FAILED' }),
    );
  });

  it('attributes a manual run to the person who asked for it', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/x.dump',
      fileName: 'x.dump',
      sizeBytes: 10,
    });
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    await service.run('database', 'manual', 'user-1');

    expect(captured.created[0]).toMatchObject({ trigger: 'manual', triggeredBy: 'user-1' });
  });

  it('archives attachments with a file count — a dump alone is not recoverable (Q33)', async () => {
    vi.mocked(archiveUtil.archiveAttachments).mockResolvedValue({
      filePath: '/a.tar.gz',
      fileName: 'a.tar.gz',
      sizeBytes: 2048,
      sha256: 'b'.repeat(64),
      fileCount: 7,
      manifestPath: '/a.tar.gz.manifest.json',
    });
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    const result = await service.run('attachments', 'schedule');

    expect(result.success).toBe(true);
    expect(result.fileCount).toBe(7);
    // The checksum is taken from what the DESTINATION stored, not from what the
    // archiver reported. With encryption on they are different bytes, and
    // recording the plaintext hash would give a checksum that can never be
    // verified against the file on disk.
    expect(captured.updated[0]).toMatchObject({ fileCount: 7, sha256: 'a'.repeat(64) });
  });

  it('passes the configured paths through to pg_dump', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/tmp/x.dump',
      fileName: 'x.dump',
      sizeBytes: 1,
    });
    const { prisma } = fakePrisma();
    const config = fakeConfig({
      backupDatabaseUrl: 'postgresql://cnap_backup:p@host:5432/db',
      backupDir: '/custom/backups',
      pgDumpPath: '/opt/homebrew/opt/postgresql@18/bin/pg_dump',
    });
    const service = new BackupService(
      config, fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    await service.run('database', 'schedule');

    expect(pgDumpUtil.runPgDump).toHaveBeenCalledWith({
      databaseUrl: 'postgresql://cnap_backup:p@host:5432/db',
      backupDir: '/custom/backups',
      pgDumpPath: '/opt/homebrew/opt/postgresql@18/bin/pg_dump',
    });
  });

  it('refuses to dump without a BYPASSRLS role, and says how to fix it', async () => {
    // The defect this found: 43 tables FORCE row-level security and every
    // application role is NOBYPASSRLS, so pg_dump as cnap_owner fails on the
    // first of them. Failing early with an actionable message beats failing
    // deep inside pg_dump with a Postgres error nobody maps back to a role.
    const { prisma, captured } = fakePrisma();
    const service = new BackupService(
      fakeConfig({ backupDatabaseUrl: undefined }),
      fakeSchedulerRegistry(),
      prisma,
      fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    const result = await service.run('database', 'schedule');

    expect(result.success).toBe(false);
    expect(result.error).toContain('BACKUP_DATABASE_URL');
    expect(result.error).toContain('nfr010-backup-role.sql');
    expect(pgDumpUtil.runPgDump).not.toHaveBeenCalled();
    // Still recorded as a failed run, not swallowed.
    expect(captured.updated[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses to dump when a table has no backup read policy', async () => {
    // pg_dump runs with --enable-row-security, and under that flag a table the
    // backup role cannot read is dumped as EMPTY rather than failing. The run
    // would go green with a valid checksum and the missing rows would surface
    // only during a restore, so the dump is refused instead.
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/x.dump',
      fileName: 'x.dump',
      sizeBytes: 4096,
    });
    const { prisma, captured } = fakePrisma({ uncoveredTables: ['needs', 'evidence'] });
    const service = new BackupService(
      fakeConfig(),
      fakeSchedulerRegistry(),
      prisma,
      fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    const result = await service.run('database', 'schedule');

    expect(result.success).toBe(false);
    expect(result.error).toContain('needs, evidence');
    expect(pgDumpUtil.runPgDump).not.toHaveBeenCalled();
    expect(captured.updated[0]).toMatchObject({ status: 'failed' });
  });

  it('emails the System Admins when a backup fails', async () => {
    // backup_runs and SystemLog both record it, but both are pull. This is the
    // push, and it is the difference between finding out on Tuesday and finding
    // out during a restore.
    vi.mocked(pgDumpUtil.runPgDump).mockRejectedValue(new Error('spawn pg_dump ENOENT'));
    const { prisma } = fakePrisma();
    const mailer = fakeMailer();
    const service = new BackupService(
      fakeConfig(),
      fakeSchedulerRegistry(),
      prisma,
      fakeSystemLog(),
      mailer,
      fakeDestination(),
    );

    await service.run('database', 'schedule');

    expect(mailer.sendBackupFailureAlert).toHaveBeenCalledWith(
      ['admin@platform.local'],
      expect.objectContaining({ kind: 'database' }),
    );
  });

  it('never prunes the newest successful run of a kind, whatever retention says', async () => {
    // A retention policy that can leave you with no backup at all is not a
    // retention policy.
    const newest = { id: 'keep-me', filePath: '/keep.dump', fileName: 'keep.dump' };
    const { prisma } = fakePrisma({ rows: [newest] });
    const service = new BackupService(
      fakeConfig(), fakeSchedulerRegistry(), prisma, fakeSystemLog(),
      fakeMailer(),
      fakeDestination(),
    );

    await service.pruneExpired();

    const call = vi.mocked(prisma.backupRun.findMany).mock.calls[0]![0] as {
      where: { id: { notIn: string[] } };
    };
    expect(call.where.id.notIn).toContain('keep-me');
  });
});
