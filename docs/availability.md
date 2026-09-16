# Availability — RIO-NFR-011

The operational half of the pilot: what the platform promises to be up for, when
it is deliberately taken down, and what happened when it went down by accident.

> **Status: the availability target is not agreed yet.** The ticket says
> "target to be confirmed during technical design" and that confirmation has not
> come back. Everything below is in place and usable; the one number that turns
> AC 1 from "we can measure this" into "we met this" is still open. See
> [Open decisions](#open-decisions).

---

## What is already in place

| Capability | Where |
|---|---|
| Liveness probe | `GET /api/health` |
| Database probe | `GET /api/health/db` — 503 when Postgres is unreachable |
| Redis probe | `GET /api/health/redis` — 503 when Redis is unreachable |
| Scheduled backups | `BackupService` (`pg_dump`, see the backup module) |
| Failure runbook | `README.md` → Operational runbook |
| Load profile | `load-test/` — Artillery, pilot volume |
| Performance regression | `test/dashboard-perf-regression.e2e.spec.ts`, `test/report-perf-regression.e2e.spec.ts` |

The three probes are what an external uptime monitor should poll. They are
unauthenticated by design so a monitor does not need a credential, and they
return 503 rather than a body that leaks driver errors or hostnames.

**Recommended monitor configuration** — not yet provisioned:

| Probe | Interval | Alert after |
|---|---|---|
| `/api/health` | 60s | 2 consecutive failures |
| `/api/health/db` | 60s | 2 consecutive failures |
| `/api/health/redis` | 300s | 3 consecutive failures |

Redis is deliberately slacker: `RateLimitGuard` fails **open** when Redis is
down, so a Redis outage degrades rate limiting rather than taking the platform
with it. It is not a user-facing outage and should not page anyone at night.

---

## Planned maintenance windows

*Satisfies AC 2.*

### The window

**Fridays, 02:00–04:00 Riyadh time (UTC+3).**

Chosen because it is the lowest-traffic window for this user base: Friday is the
weekend in Saudi Arabia, and field researchers do not collect data at 2am. Two
hours is enough for a migration plus a verified rollback.

Not every Friday is used. The window is a standing *reservation*; most weeks
nothing happens in it.

### Notice

| Change | Notice | How |
|---|---|---|
| Schema migration, dependency upgrade, config change | **5 working days** | Email to each entity's NGO Admin + in-app banner from day 1 |
| Security patch that cannot wait | **24 hours** | Same channels, marked urgent |
| Incident recovery | None possible | Announced as it happens; logged below afterwards |

The notice states: what is changing, the exact window, whether the platform will
be unreachable or only degraded, and who to contact if the timing is a problem
for a live data-collection round.

### Counting against the target

Announced maintenance inside the window **does not** count against availability.
Anything else does — including a maintenance action that overruns its window,
which is counted from the moment the window closed.

That distinction is the reason the window exists. Without it, every planned
migration looks identical to an outage in the numbers.

---

## Incident and downtime log

*Satisfies AC 3.*

Every unplanned unavailability gets a row, however short. A five-minute blip
nobody logged is indistinguishable from a five-minute blip that never happened,
and at pilot scale a handful of unlogged blips is the difference between meeting
a target and not knowing.

**One row per incident. Fill it the same day.**

| # | Detected | Resolved | Duration | Scope | What happened | Root cause | Fix | Counts against target |
|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | *No incidents recorded yet — the pilot has not started.* | — | — | — |

### Column meanings

- **Detected / Resolved** — UTC, to the minute. Detected is when the *first*
  signal appeared (monitor alert, user report), not when someone started work.
- **Scope** — `full` (nobody could use it), `partial` (one feature, e.g. exports),
  or `degraded` (slow but working). Only `full` and `partial` count against the
  target; degraded is tracked separately.
- **Counts against target** — `yes`, or `no` with the reason (announced
  maintenance, upstream provider outage outside our control, and so on).

### What to do during an incident

1. Confirm scope with the three probes before announcing anything — a failing
   `/health/redis` alone is not an outage.
2. Post in the entity-admin channel: what is broken, what still works, next update time.
3. Follow the failure-mode entry in `README.md` → Operational runbook.
4. Add the row here the same day, while the detail is still accurate.
5. If the root cause is not yet known, write `under investigation` and update it —
   do not leave the row out until you know.

---

## Open decisions

These block sign-off, not the work.

| # | Question | Who | Why it blocks |
|---|---|---|---|
| 1 | **What availability level are we committing to?** 99%, 99.5%, or business-hours-only? | Client / technical design track | AC 1 is unverifiable without a number. 99% and 99.5% are ~7h and ~3.5h of monthly downtime — very different operational commitments. |
| 2 | Measured over what period — monthly or the whole pilot? | Client | A single bad day can fail a monthly target and pass a pilot-long one. |
| 3 | Is the Friday 02:00–04:00 window acceptable to the entities? | Client | Proposed here, not agreed. |
| 4 | Who provisions and watches the uptime monitor? | Labs24 / client | Nothing is polling the probes today, so nothing would detect an outage out of hours. |

Until question 1 is answered, the honest status of AC 1 is **"we can measure
it, we have not been told what to measure against"** — not "met" and not
"failed".
