import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { SystemLogsService } from '../system-logs/system-logs.service';
import { chainSign, computeDigest, type CheckpointRow } from './audit-checkpoint.crypto';

const CRON_JOB_NAME = 'audit-checkpoint';
// Hard cap on rows read per run — a pathological backlog must not turn one
// tick of the job into an unbounded read. A future run picks up where this
// one left off (the next checkpoint's coverage simply starts after this
// batch's last row).
const BATCH_CAP = 50_000;

export interface VerifyResult {
  ok: boolean;
  brokenCheckpointId?: string;
}

interface AuditCheckpointRecord {
  id: string;
  prevChainHash: string | null;
  coveredFromId: string | null;
  coveredToId: string;
  coveredToCreatedAt: Date;
  rowCount: number;
  digest: string;
  signature: string;
  createdAt: Date;
}

// Coverage-window boundary predicates. audit_logs.created_at is
// TIMESTAMPTZ(6) (microsecond precision) but a JS Date — what a checkpoint
// row's coveredToCreatedAt round-trips through — only carries millisecond
// precision. Bounding on a *re-derived* `createdAt` equality/inequality
// (e.g. `createdAt: { lte: cp.coveredToCreatedAt }`) can therefore silently
// exclude the very row the checkpoint says it covers, whenever that row's
// true timestamp has non-zero sub-millisecond digits — which happens
// routinely in practice, not as an edge case. `id` (server-generated
// uuidv7, monotonic with creation time and, unlike created_at, guaranteed
// unique) is the precision-safe boundary instead: coveredToCreatedAt is
// still stored and used as the *sort key* (and by checkpoint() to select
// candidate rows economically), but the boundary itself is drawn on id
// alone once the row's own createdAt no longer help discriminate exactly.
function afterBoundary(afterId: string): Record<string, unknown> {
  return { id: { gt: afterId } };
}

/** id <= uptoId. */
function uptoBoundary(uptoId: string): Record<string, unknown> {
  return { id: { lte: uptoId } };
}

/**
 * GAP-02 — periodic signed checkpoint job over audit_logs, and its verifier.
 *
 * Append-only is already enforced for the app on audit_logs itself
 * (cnap_app has SELECT, INSERT only — no UPDATE/DELETE). The residual
 * threat this job addresses is a privileged actor (DB owner/superuser)
 * editing audit_logs history directly, bypassing the app entirely. Each run
 * reads every audit row since the last checkpoint's boundary — rows are
 * read and digested in (createdAt, id) order (createdAt is not unique, so
 * id, a server-generated uuidv7, is the tie-breaker for a deterministic
 * digest order), but the coverage *boundary* itself is drawn on id alone
 * (see afterBoundary/uptoBoundary's comment for why: a JS Date only carries
 * millisecond precision, while created_at is TIMESTAMPTZ(6)/microsecond —
 * bounding on a re-derived createdAt comparison can silently drop the
 * boundary row itself). Each run computes a digest over its rows, chains it
 * to the previous checkpoint's signature, and signs it. verify() recomputes
 * each checkpoint's digest+signature from the *current* state of the
 * covered audit_logs rows and compares — any edit, insert-between, or
 * delete within a covered window changes the digest and is caught. This is
 * a single global chain spanning every org (checkpoints carry no org
 * ownership — see the migration's no-RLS comment).
 *
 * Mirrors CitizenPiiRetentionService's cron/never-throwing pattern.
 */
@Injectable()
export class AuditCheckpointService implements OnModuleInit {
  private readonly logger = new Logger(AuditCheckpointService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tenant: TenantPrismaService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly systemLogs: SystemLogsService,
  ) {}

  onModuleInit(): void {
    const schedule = this.config.auditCheckpointCron;
    const job = new CronJob(schedule, () => {
      void this.checkpoint();
    });
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(`Audit checkpoint job scheduled (cron: "${schedule}")`);
  }

  /** Never throws — a failed checkpoint run must not crash the app. */
  async checkpoint(): Promise<void> {
    try {
      // 1. Latest checkpoint, if any — cnap_supervisor can SELECT
      //    audit_checkpoints (see the migration's grants).
      const [last] = (await this.tenant.runAsSupervisor((tx) =>
        tx.auditCheckpoint.findMany({ orderBy: { createdAt: 'desc' }, take: 1 }),
      )) as AuditCheckpointRecord[];

      // 2. Next batch of audit rows since the last checkpoint's boundary —
      //    cross-org read, same supervisor client. No prior checkpoint =
      //    genesis: every existing row is in scope.
      const rows = (await this.tenant.runAsSupervisor((tx) =>
        tx.auditLog.findMany({
          where: last ? afterBoundary(last.coveredToId) : undefined,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: BATCH_CAP,
        }),
      )) as unknown as CheckpointRow[];

      if (rows.length === 0) return;

      // 3. Digest + chain-sign.
      const digest = computeDigest(rows);
      const signature = chainSign(last?.signature ?? null, digest, this.config.auditSigningKey);
      const first = rows[0]!;
      const lastRow = rows[rows.length - 1]!;

      // 4. Insert the checkpoint — cnap_app INSERT on the no-RLS table (no
      //    org GUC set: a checkpoint is not org-owned data).
      const created = await this.tenant.runAsSupervisorWrite((tx) =>
        tx.auditCheckpoint.create({
          data: {
            prevChainHash: last?.signature ?? null,
            coveredFromId: first.id,
            coveredToId: lastRow.id,
            coveredToCreatedAt: lastRow.createdAt,
            rowCount: rows.length,
            digest,
            signature,
          },
        }),
      );

      this.logger.log(
        `Audit checkpoint created: covered ${rows.length} row(s) up to ${lastRow.id} ` +
        `(${lastRow.createdAt.toISOString()})`,
      );

      this.mirrorOffBox(created as AuditCheckpointRecord);
    } catch (err) {
      this.logger.error(
        'Audit checkpoint run failed',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * GAP-02 Task 5 first cut — off-box anchor. A checkpoint is only
   * trustworthy as tamper-evidence if a copy of it lives somewhere a DB
   * admin/owner can't quietly edit alongside the audit_logs/audit_checkpoints
   * tables it's meant to protect. The real answer is an external sink
   * (object storage with retention/immutability, or an external log
   * service) — deliberately NOT built here; that needs a sink decision this
   * plan defers explicitly. This first cut mirrors the checkpoint's
   * identifying fields into SystemLogsService, which is at least a
   * different code path/table (and, once SystemLogsService ships its own
   * external shipping, a different destination) than audit_checkpoints
   * itself. Best-effort: SystemLogsService.record() already never throws by
   * its own contract, but this is wrapped anyway so a mirror failure can
   * never take down a checkpoint run that has already committed.
   */
  private mirrorOffBox(cp: AuditCheckpointRecord): void {
    try {
      this.systemLogs.record({
        level: 'info',
        category: 'job',
        source: AuditCheckpointService.name,
        eventCode: 'AUDIT_CHECKPOINT_CREATED',
        message: `Audit checkpoint ${cp.id} created, covering up to audit_logs row ${cp.coveredToId}`,
        context: {
          id: cp.id,
          coveredToId: cp.coveredToId,
          digest: cp.digest,
          signature: cp.signature,
        },
      });
    } catch (err) {
      this.logger.error(
        'Audit checkpoint off-box mirror failed (checkpoint itself was still recorded)',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Walk every checkpoint oldest-first, re-reading each one's covered
   * audit_logs window (bounded by the previous checkpoint's boundary,
   * exclusive, up to this checkpoint's own boundary, inclusive — the exact
   * window checkpoint() wrote it from) from current state, and recomputing
   * digest + chain signature. The first mismatch — a checkpoint whose
   * recomputed signature no longer matches what was stored, or whose
   * prevChainHash no longer matches the actual previous signature — means
   * either its covered audit rows were altered/deleted after the fact, or
   * the checkpoint row itself was tampered with. Returns that checkpoint's
   * id.
   */
  async verify(): Promise<VerifyResult> {
    // `id` (uuidv7) is a monotonic secondary sort here — same reliance on
    // server-generated uuidv7 monotonicity (no client-supplied-id path) that
    // the coverage boundaries (afterBoundary/uptoBoundary) already depend
    // on — so two checkpoints created within the same createdAt microsecond
    // still walk in chain order.
    const checkpoints = (await this.tenant.runAsSupervisor((tx) =>
      tx.auditCheckpoint.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    )) as AuditCheckpointRecord[];

    let prevSignature: string | null = null;
    let prevBoundaryId: string | null = null;

    for (const cp of checkpoints) {
      const where = prevBoundaryId
        ? { AND: [afterBoundary(prevBoundaryId), uptoBoundary(cp.coveredToId)] }
        : uptoBoundary(cp.coveredToId);

      const covered = (await this.tenant.runAsSupervisor((tx) =>
        tx.auditLog.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      )) as unknown as CheckpointRow[];

      const digest = computeDigest(covered);
      const signature = chainSign(prevSignature, digest, this.config.auditSigningKey);

      if (
        digest !== cp.digest ||
        signature !== cp.signature ||
        cp.prevChainHash !== prevSignature ||
        covered.length !== cp.rowCount
      ) {
        return { ok: false, brokenCheckpointId: cp.id };
      }

      prevSignature = cp.signature;
      prevBoundaryId = cp.coveredToId;
    }

    return { ok: true };
  }
}
