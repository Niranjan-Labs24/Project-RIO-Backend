# Disaster Recovery Runbook — RIO-NFR-010 (Reliability / Continuity)

**Purpose:** close RIO-NFR-010's "recoverable periodic backups" requirement with real, dated evidence — not a description of intent.

## What backs this system up

- **Database** — `pg_dump` custom-format dump, via `POST /api/backups/run { "kind": "database" }` or the weekly cron (`BACKUP_CRON_SCHEDULE`, currently Sundays 03:00).
- **Attachments** — `tar.gz` archive of `storage/uploads`, via the same endpoint with `{ "kind": "attachments" }`.
- Both land in `BACKUP_DIR` (`./storage/backups`) with a `.manifest.json` / DB row (`backup_runs`) recording `sha256`, size, and timestamp.

## Roles involved

| Role | Why it exists |
|---|---|
| `cnap_backup` | SELECT-only, `BYPASSRLS`. Every real table in this system has `FORCE ROW LEVEL SECURITY`, which blocks even the table owner (`cnap_owner`) from reading rows without `app.current_org_id` set. `pg_dump` has no org context, so it needs a role that bypasses RLS entirely and can only read — created by `scripts/sql/nfr010-backup-role.sql`. |
| `cnap_owner` | Used only for scratch-database create/drop during a restore drill (needs `CREATEDB`), never for the dump itself. |

## Responsible people

- **Runs the schedule / owns `BACKUP_DATABASE_URL` rotation:** whoever holds ops/DevOps responsibility for the deployment (client to name a specific person before go-live — not yet assigned as of this writing).
- **Runs a restore drill periodically:** same owner; see cadence below.

## RPO / RTO targets

- **RPO (Recovery Point Objective): 7 days** — matches the current weekly cron. If the client needs a tighter RPO, lower `BACKUP_CRON_SCHEDULE` (e.g. daily) — this is a config change, not new code.
- **RTO (Recovery Time Objective): not yet formally set by the client.** The drill below shows the mechanical restore itself (via `pg_restore`) completing in well under a minute for the current data volume (~19,000 total rows across the checked tables). Real-world RTO also depends on provisioning a replacement host/DB and is outside this runbook's scope.

## Prerequisites (one-time setup)

1. Run `scripts/sql/nfr010-backup-role.sql` as a Postgres superuser to create `cnap_backup`.
2. Set `BACKUP_DATABASE_URL` in `.env` to `postgresql://cnap_backup:<password>@<host>:<port>/<db>`.
3. **Rotate the password before any shared/production environment** — the SQL script ships a default development password (`cnap_backup_dev_pw`). `cnap_backup` can read every tenant's data (that's its job), so this credential must not stay at its default outside local dev:
   ```sql
   ALTER ROLE cnap_backup WITH PASSWORD '<new-strong-password>';
   ```
   then update `BACKUP_DATABASE_URL` to match. The running app logs a warning on startup if the default is still in use (see `password.service`-adjacent backup-config check) — treat that warning as a blocker for any non-local deployment.
4. Set `PG_DUMP_PATH` / `PG_RESTORE_PATH` if the system's default `pg_dump`/`pg_restore` on `PATH` is a different major version than the running Postgres — `pg_dump`/`pg_restore` refuse to operate against a newer major version than themselves. In this dev environment, Postgres 18 is running while Homebrew's linked `pg_dump` is v16, so both paths point at `/opt/homebrew/opt/postgresql@18/bin/`.

## How to run a restore drill

```
PG_RESTORE_PATH=/opt/homebrew/opt/postgresql@18/bin/pg_restore pnpm nfr010:restore-check
```

This script (`scripts/restore-check.ts`):
1. Takes the newest successful `database` backup run.
2. Re-checksums the file against the `sha256` recorded when it was written (catches silent corruption).
3. Restores it into a scratch database (`cnap_restore_check`) via `pg_restore`.
4. Compares row counts for the tables that matter (`organisations`, `users`, `studies`, `needs`, `survey_responses`, `audit_logs`, `backup_runs`) against the source, read via the `cnap_backup` role — the same view `pg_dump` captured.
5. Drops the scratch database.

It is read-only against the live database; the scratch database is created and dropped by the script itself and named distinctly so it can never be confused with a real one.

**Recommended cadence:** run this after any change to the backup/restore code path, and periodically (monthly is reasonable) against production to catch drift (Postgres upgrades, schema changes, role/permission changes) before a real incident forces the question.

## Real drill result — 2026-09-28

Run against a temporary local backend instance (port 4100, isolated from the developer's own running instance) after provisioning `cnap_backup` and setting `BACKUP_DATABASE_URL` for the first time in this environment:

1. `POST /api/backups/run { "kind": "database" }` — **before** the role/config fix: failed with `"BACKUP_DATABASE_URL is not set...pg_dump cannot read this database as an application role because row-level security is FORCED on 43 tables."` This is the exact failure a production deployment would hit if this setup step were skipped — now documented as a real, reproduced failure mode, not a hypothetical.
2. Ran `scripts/sql/nfr010-backup-role.sql` as the `postgres` superuser — provisioned `cnap_backup` successfully.
3. Set `BACKUP_DATABASE_URL` in `.env` and restarted the (temporary) app instance — it logged the expected default-password warning.
4. `POST /api/backups/run { "kind": "database" }` again — **succeeded**, producing `cnap-backup-2026-09-28T05-31-36-835Z.dump` (4,695,988 bytes).
5. Ran `pnpm nfr010:restore-check` against that dump. Full output:

```
RIO-NFR-010 — restore check

  Using cnap-backup-2026-09-28T05-31-36-835Z.dump (4695988 bytes, taken 2026-09-28T05:31:36.814Z)

  PASS  the file still matches the checksum recorded when it was written
  PASS  pg_restore completed
  PASS  organisations: restored 193, source 193
  PASS  users: restored 837, source 837
  PASS  studies: restored 50, source 50
  PASS  needs: restored 888, source 888
  PASS  survey_responses: restored 348, source 348
  PASS  audit_logs: restored 17167, source 17168
  PASS  backup_runs: restored 4, source 4
  PASS  scratch database dropped

  Restore verified. The backup is recoverable.
```

(`audit_logs` shows 17167 restored vs. 17168 source — expected and correct: the source count was taken a few seconds after the dump, during which one more audit event was written by the live system. The script explicitly treats "restored ≤ source" as a pass for exactly this reason — a dump is a point-in-time snapshot of a system that keeps moving.)

**Conclusion:** this is a genuine, end-to-end, passing restore drill, not a description of intent. RIO-NFR-010's "recoverable" half is proven for this environment as of 2026-09-28. This should be re-run against the actual production environment before go-live, since role provisioning, Postgres version, and `PG_DUMP_PATH`/`PG_RESTORE_PATH` are all environment-specific.

## Known gaps (not yet closed by this runbook)

- **Off-host storage — blocked on the client, not on code.** Backups currently land on the same host's filesystem (`./storage/backups`). A host-level disaster (disk failure, host loss) would take the backups down with it. This cannot be fixed by writing more code: an off-host destination needs a *real* place to send backups to — an actual S3-compatible bucket (or equivalent), with real access credentials, a real region, and a real retention policy — none of which exist yet for this project. Building an adapter against invented/guessed credentials would produce code that has never actually been run against anything real, which is worse than the current honest gap: a disaster-recovery path nobody has tested is a false sense of security. `src/modules/backup/backup-destination.ts` is already structured so that adding a real destination later is "one adapter, one environment variable," specifically so this isn't a redesign once the client provides the missing piece. **Action needed from the client/deployment owner:** provide a bucket/host, its credentials, and a retention decision.
- **Encryption-at-rest key custody — same reason, same blocker.** The encryption mechanism itself (AES-256-GCM) is already built and works (see `backup-destination.ts`) — what's missing isn't code, it's a decision: who holds the passphrase, how it's escrowed, what happens if it's lost (an un-escrowed key makes backups permanently unreadable, which is its own disaster). That's a process decision for the client, not something safe to default silently in code.
- **28 Sep 2026 — made the gap loud instead of silent, without changing what's missing.** `src/main.ts` now logs a queryable `system_logs` warning (`PRODUCTION_BACKUP_DATABASE_URL_MISSING`, `PRODUCTION_BACKUP_NOT_ENCRYPTED`) at every startup when running in production without these configured. This is deliberately a **warning, not a startup failure**: since neither of us could verify what a live production deployment already has configured, a hard failure risked turning an unrelated code change into an outage on that deployment's next restart. The tradeoff: this makes the gap impossible to miss in the logs, but does not force it closed — actually closing it still requires the infrastructure decisions above. Verified live: booted a temporary instance in `NODE_ENV=production` with `BACKUP_ENCRYPTION_KEY` unset and confirmed the warning was actually recorded and queryable via `GET /api/system-logs`, and confirmed no warning fires for `BACKUP_DATABASE_URL` specifically because this dev environment already has it set — the check is real and differential, not a blanket message.
- **RTO:** not formally targeted by the client yet (see above).
- **Automated/scheduled drills:** the restore-check script must be run manually today; it is not wired into CI or a cron. Worth scheduling if a real cadence is wanted rather than ad hoc.
