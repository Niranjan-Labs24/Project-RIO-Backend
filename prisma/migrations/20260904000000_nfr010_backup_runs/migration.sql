-- RIO-NFR-010 — Data Backup.
--
-- AC 2 is "backup logs auditable". Today a run writes a line to stdout and
-- nothing else: a rotating text log cannot answer "did last Tuesday's backup
-- succeed", "how large was it", "is the file we are about to restore the one
-- that was written", or "what have we deleted under retention". A queryable
-- row per run, carrying a checksum, can answer all four.
--
-- Deliberately NOT AuditLog. That table is the immutable business-event record
-- (RIO-FR-007), whose own acceptance criterion is that rows cannot be deleted,
-- so it must never carry a purge path. A backup run is operational telemetry
-- with a retention window — the same reasoning that produced SystemLog under
-- NFR-016. The human-initiated ACTS (someone triggered a backup, someone
-- pruned old ones) still go to AuditLog; the machine record lives here.
--
-- No org_id and no RLS: backups are platform infrastructure, not tenant data.
-- A dump contains every entity's rows, so it cannot belong to one of them. The
-- API is gated on systemLogs (System Admin only) for the same reason.

CREATE TABLE "backup_runs" (
  "id"            UUID PRIMARY KEY DEFAULT uuidv7(),

  -- 'database' or 'attachments'. Two kinds because they fail independently and
  -- a restore needs both: a database dump without the evidence files restores
  -- rows pointing at missing documents (Q33).
  "kind"          VARCHAR(20)  NOT NULL,

  -- 'running' | 'succeeded' | 'failed'. A row is written when the run STARTS,
  -- so a process killed mid-dump leaves a visible 'running' row rather than no
  -- evidence at all — the failure mode this ticket exists to prevent is the
  -- silent one.
  "status"        VARCHAR(20)  NOT NULL,

  -- 'schedule' or 'manual', plus who for a manual run. A backup appearing at
  -- an odd hour should be attributable.
  "trigger"       VARCHAR(20)  NOT NULL,
  "triggered_by"  UUID,

  "started_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at"   TIMESTAMPTZ(6),
  "duration_ms"   INTEGER,

  "file_name"     VARCHAR(255),
  "file_path"     VARCHAR(1000),
  "size_bytes"    BIGINT,

  -- SHA-256 of the written file. This is what makes "recoverable" checkable
  -- without a restore: a dump that no longer matches its checksum is corrupt,
  -- and finding that out during a disaster is finding out too late.
  "sha256"        VARCHAR(64),

  -- How many files an attachment run captured, and their total size. Null for
  -- a database run.
  "file_count"    INTEGER,

  -- When this run may be deleted by the retention sweep. Null means keep
  -- indefinitely; the sweep also refuses to delete the newest successful run
  -- of each kind whatever this says.
  "retain_until"  TIMESTAMPTZ(6),
  "pruned_at"     TIMESTAMPTZ(6),

  -- Populated only on failure. Truncated by the service, not the column, so a
  -- long stack trace never fails the INSERT that records the failure.
  "error"         VARCHAR(2000),

  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "backup_runs_kind_check"
    CHECK ("kind" IN ('database', 'attachments')),
  CONSTRAINT "backup_runs_status_check"
    CHECK ("status" IN ('running', 'succeeded', 'failed')),
  CONSTRAINT "backup_runs_trigger_check"
    CHECK ("trigger" IN ('schedule', 'manual')),

  -- A manual run must say who asked for it; a scheduled one has no actor.
  CONSTRAINT "backup_runs_manual_has_actor"
    CHECK (
      ("trigger" = 'manual'  AND "triggered_by" IS NOT NULL) OR
      ("trigger" = 'schedule' AND "triggered_by" IS NULL)
    ),

  -- A finished run must be finished consistently: a status that is no longer
  -- 'running' has an end time, and one that is still running has not.
  CONSTRAINT "backup_runs_finished_consistently"
    CHECK (
      ("status" = 'running'  AND "finished_at" IS NULL AND "duration_ms" IS NULL) OR
      ("status" <> 'running' AND "finished_at" IS NOT NULL AND "duration_ms" IS NOT NULL)
    ),

  -- A success must have produced a file we can name, size and verify. Without
  -- this a bug could record a "successful" backup with no artefact, which is
  -- the most dangerous row this table could contain.
  CONSTRAINT "backup_runs_success_has_artefact"
    CHECK (
      "status" <> 'succeeded' OR (
        "file_name" IS NOT NULL AND
        "file_path" IS NOT NULL AND
        "size_bytes" IS NOT NULL AND
        "sha256"     IS NOT NULL
      )
    ),

  -- And a failure must say why.
  CONSTRAINT "backup_runs_failure_has_reason"
    CHECK ("status" <> 'failed' OR "error" IS NOT NULL)
);

-- The two questions this screen is opened to answer: "what happened recently"
-- and "when did this kind last succeed".
CREATE INDEX "backup_runs_started_at_idx" ON "backup_runs" ("started_at" DESC);
CREATE INDEX "backup_runs_kind_status_started_idx"
  ON "backup_runs" ("kind", "status", "started_at" DESC);
-- The retention sweep's own query.
CREATE INDEX "backup_runs_retain_until_idx"
  ON "backup_runs" ("retain_until")
  WHERE "pruned_at" IS NULL;

GRANT SELECT, INSERT, UPDATE ON "backup_runs" TO cnap_app;
-- No DELETE. Retention removes the FILE and stamps pruned_at; the record of
-- what was backed up and later pruned is itself part of the audit trail, and
-- deleting it would leave a hole exactly where an auditor looks.
GRANT SELECT ON "backup_runs" TO cnap_supervisor;
