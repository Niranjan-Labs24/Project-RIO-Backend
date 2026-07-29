import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { BackupService } from './backup.service';
import * as pgDumpUtil from './pg-dump.util';
import type { ConfigService } from '../../config/config.service';

vi.mock('./pg-dump.util', () => ({
  runPgDump: vi.fn(),
}));

function fakeConfig(
  overrides: Partial<{
    databaseUrl: string;
    backupDir: string;
    backupCronSchedule: string;
    pgDumpPath: string | undefined;
  }> = {},
): ConfigService {
  return {
    databaseUrl: 'postgresql://cnap_owner:cnap_owner_dev_pw@localhost:5432/cnap',
    backupDir: './storage/backups',
    backupCronSchedule: '0 */2 * * *',
    pgDumpPath: undefined,
    ...overrides,
  } as unknown as ConfigService;
}

function fakeSchedulerRegistry(): SchedulerRegistry {
  return {
    addCronJob: vi.fn(),
  } as unknown as SchedulerRegistry;
}

describe('BackupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a cron job on init using the configured schedule', () => {
    const scheduler = fakeSchedulerRegistry();
    const service = new BackupService(fakeConfig({ backupCronSchedule: '0 */2 * * *' }), scheduler);

    service.onModuleInit();

    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
    expect(scheduler.addCronJob).toHaveBeenCalledWith('database-backup', expect.anything());
  });

  it('returns a success result with file details when pg_dump succeeds', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/app/storage/backups/cnap-backup-2026-07-28T00-00-00-000Z.dump',
      fileName: 'cnap-backup-2026-07-28T00-00-00-000Z.dump',
      sizeBytes: 4096,
    });
    const service = new BackupService(fakeConfig(), fakeSchedulerRegistry());

    const result = await service.runBackup();

    expect(result.success).toBe(true);
    expect(result.fileName).toBe('cnap-backup-2026-07-28T00-00-00-000Z.dump');
    expect(result.sizeBytes).toBe(4096);
    expect(result.error).toBeUndefined();
  });

  it('never throws and returns a failure result when pg_dump rejects', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockRejectedValue(new Error('spawn pg_dump ENOENT'));
    const service = new BackupService(fakeConfig(), fakeSchedulerRegistry());

    const result = await service.runBackup();

    expect(result.success).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(result.filePath).toBeUndefined();
  });

  it('passes the configured databaseUrl and backupDir through to pg_dump', async () => {
    vi.mocked(pgDumpUtil.runPgDump).mockResolvedValue({
      filePath: '/tmp/x.dump',
      fileName: 'x.dump',
      sizeBytes: 1,
    });
    const config = fakeConfig({
      databaseUrl: 'postgresql://u:p@host:5432/db',
      backupDir: '/custom/backups',
      pgDumpPath: '/opt/homebrew/opt/postgresql@18/bin/pg_dump',
    });
    const service = new BackupService(config, fakeSchedulerRegistry());

    await service.runBackup();

    expect(pgDumpUtil.runPgDump).toHaveBeenCalledWith({
      databaseUrl: 'postgresql://u:p@host:5432/db',
      backupDir: '/custom/backups',
      pgDumpPath: '/opt/homebrew/opt/postgresql@18/bin/pg_dump',
    });
  });
});
