# RIO-NFR-006 — Scalability load test

Proves the scalability claim (row-per-entity multitenancy + per-request RLS +
bounded pagination scale at pilot volume **without rebuild**) with a real
Artillery run against a running API seeded to pilot scale.

## Files
- `load-seed.ts` — seeds **50 orgs × 10 NGO-Admin users (500 accounts)** and writes `users.csv`.
- `pilot.yml` — two weighted Artillery scenarios sharing the same phases:
  - `auth-then-reads` (weight 80): `login` (once) → loop×2 `[me, organizations/current, users, audit]`.
  - `auth-then-write` (weight 20): `login` (once) → loop×2 `[me, users, **PATCH own user (idempotent)**]` — exercises the write path (`RequirePermission` guard + per-request RLS transaction) under the same concurrency.
  - Every read/write runs inside a per-request RLS transaction — the thing that must scale.
- `users.csv`, `report.json` — generated (git-ignored).

## Run it
```bash
# 1. DB up + base seed (roles/consent/demo)
pnpm db:up && pnpm prisma:seed

# 2. Pilot-volume seed (writes load-test/users.csv)
pnpm load:seed

# 3. Start the built API on :4100 (plain HTTP for the load client)
pnpm build && PORT=4100 node dist/main.js      # in a separate shell

# 4. Drive the load
pnpm test:load
```
Thresholds are enforced in `pilot.yml` (`ensure`): **p95 < 500 ms**, **error rate < 1 %**.

## Acceptance thresholds

These are the pass/fail bars for a load run against a production-like environment
(single app instance + dedicated Postgres/Redis, not shared with other workloads):

| Metric | Threshold | How it's measured |
|---|---|---|
| p95 latency | < 500 ms | Artillery `ensure.thresholds` (enforced automatically, run fails otherwise) |
| p99 latency | < 1000 ms | Artillery summary report (not auto-enforced — reviewed manually) |
| Error rate (non-2xx) | < 1 % | Artillery `ensure.maxErrorRate` (enforced automatically) |
| Process heap (RSS) | < 80 % of container memory limit | `docker stats` (or `process.memoryUsage()` if metrics are wired up) sampled during the sustained phase |
| Postgres connections in use | < 80 % of `max_connections`, and the app must never see `PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.` | `SELECT count(*) FROM pg_stat_activity` sampled during the run, plus a grep of app logs for that exact error string |
| Redis connections in use | < 80 % of `maxclients` | `redis-cli INFO clients` sampled during the run (only meaningful once `REDIS_URL` is configured — see Notes below) |

### RIO-NFR-005 — Performance (dashboard/report targets)

No numeric target for this NFR exists anywhere in the BRD, Annex A, or Build
Instruction Pack — its own acceptance criteria says "target to be confirmed
during technical design," and that confirmation never happened (checked
again against all 34 answered Sprint 2 clarification questions — none cover
it). **Decision (2026-08-27): proceeding with our own internal working
targets rather than blocking on client confirmation.** These are explicitly
open to revision if the client specifies different numbers later — not
presented to them as final, just adopted so this story isn't stuck waiting.

**Superseded by Round 5 (2026-08-24, client-confirmed) and the 2026-08-27 re-test below:** the
pilot scale is 500 *concurrent* sessions, not 500 total registered accounts — and at that real
scale, the system fails functionally (94% VU failure rate, see the 2026-08-27 result below) well
before a response-time target is even meaningful to propose against real traffic. The dashboard
target below is retained as our own working number regardless — it was never contingent on the
load-test result, and there's no reason to withhold it while the connection-pool/CPU work
continues in parallel.

| Metric | Internal target (ours, not client-confirmed — revisable) | Basis |
|---|---|---|
| Dashboard load (Priority Dashboard, System Admin Dashboard, etc.) | **< 3 seconds** | Standard web-app responsiveness bar |
| Report generation (PDF/Excel, non-AI content) | 10–15 seconds | Superseded by the real measurement below — kept only as the pre-measurement estimate |
| Report generation involving an AI-generated summary (executive/combined summaries) | up to 60 seconds | LLM-call latency dominates; not meaningfully reducible without changing the summarization approach |
| Report-generation test data volume | **1 study, 1 survey, ~200 submitted responses** (see note below) | Our own working assumption, not client-confirmed — see note |
| Pilot data-volume assumption the *load test itself* was run against | 50 orgs × 500 accounts (old), then real 500-*concurrent* sessions (2026-08-27 re-test) | Client-confirmed scale, separate from the report-content-volume assumption above |

**Report-generation data-volume assumption, explained:** the only seeded fixture that exercised
the real report pipeline before this (`prisma/seed-scored-study.ts`, reused by
`prisma/seed-data-quality.ts`) has **38 submitted responses** for one study/survey — a small
illustrative fixture, not a deliberate "pilot-scale" figure. Rather than block this story on the
client for their actual typical study size, we adopted **~200 responses for one study/survey** as
our own stand-in "representative pilot-scale" assumption (roughly 5x the existing fixture) —
explicitly a guess, not derived from any real operational number, and should be replaced the
moment the client provides an actual figure. **Now seeded**: `prisma/seed-report-perf.ts`
(`pnpm seed:report-perf`) creates a dedicated study/survey at this volume, kept entirely separate
from `seed-scored-study.ts` since several specs hardcode assertions against that fixture's exact
38-response count.

### Report-generation timing — real measurement, 2026-08-27

Ran RPT14 (Village Report) generation and both export formats against the 200-response fixture
above, on the built API (single dev-box instance):

| Step | First call after server start | Second call onward (steady state) |
|---|---|---|
| Report content generation (`POST /api/reports`) | 22.5 s | **150 ms** |
| PDF export (`GET .../export?format=pdf`, 34.8 KB) | not separately isolated | **124 ms** |
| Excel export (`GET .../export?format=excel`, 14.9 KB) | not separately isolated | **78 ms** |

For comparison, the same sequence against the older 38-response fixture: first call **17.4 s**,
steady-state **127 ms** — confirming the slow number is a one-time cost, not something that scales
with response count (200 responses added ~5x the data for only ~20ms more steady-state time).

**Steady-state report generation is fast — well inside the 10–15s estimate, not close to it.**
The real finding here isn't slowness; it's the **~17-22 second cost on the first report-generation
request after the server starts**, regardless of which study or response count. Not yet
root-caused (this codebase has no request-internal timing/tracing — see the Notes section below)
but consistent with a one-time lazy-initialization cost somewhere in the report-generation code
path (e.g. a heavy module's first dynamic import, or a query planner compiling a rarely-hit query
for the first time). **Worth flagging as a production consideration**: if this reproduces in a
real deployment, the *first* report any user requests after a fresh deploy/restart could appear to
hang for ~20 seconds — a warm-up request fired automatically right after each deploy (hitting
`POST /api/reports` once against known-good seed data) would absorb this cost before a real user
ever sees it, rather than trying to eliminate the underlying one-time cost itself.

The previous "10–15 seconds" figure in the table above was an informal "observed typical" guess,
not a real measurement — it happened to land in the same order of magnitude as the *cold-start*
number, not the real steady-state number, which is over 100x faster. It's superseded by this
measurement.

### Automated as a real regression test (2026-08-27, same day)

The manual timing above is now `test/report-perf-regression.e2e.spec.ts` — runs in `pnpm test`
(and therefore in CI, which now runs `pnpm seed:report-perf` before the test step). It does one
untimed warm-up call to absorb the cold-start cost documented above, then times the real,
steady-state RPT14 generation + PDF export + Excel export, asserting each against the story's own
documented targets (10s / 15s — the pre-measurement estimates, not the much tighter numbers
actually observed, so this fails loudly on a real regression without being flaky over normal CI
variance). **AC4 ("a performance regression test is run before the issue is closed") is now
satisfied for report generation** — it runs automatically on every CI run, not manually.

A companion test, `test/dashboard-perf-regression.e2e.spec.ts`, does the same for **AC1**
(dashboard load) — but only partially: there's no browser in this environment, so full dashboard
load (API + frontend render) can't be measured end-to-end. What it does measure: the real backend
call the Priority Dashboard makes on load (`GET /api/priority-scores`), budgeted at 1.5s (half the
3s total target, leaving headroom for the untested frontend-render half). **Known gap, not
silently covered**: the System Admin Dashboard and main Dashboard's `studiesService.getPlatformStats()`
call is frontend mock data (a hardcoded array with an artificial delay) — there is no real backend
endpoint yet to time for those two dashboards' initial load.

**Both tests use the synthetic `seed-report-perf.ts` fixture, not real computed scoring** — the
domain/KPI severity numbers are fixed values carried over from `seed-scored-study.ts`, not
produced by RIO-FR-003's weighting-factor wiring (still not done — see the master log). **Once
FR-003 lands, these regression tests should be re-pointed at real computed data** rather than this
synthetic fixture, so "representative pilot-scale data" (the AC's own wording) is actually true,
not just a stand-in.

**Not yet automated**: report-generation timing (unlike the API p95 above)
has no Artillery scenario or regression test today — PDF/Excel/AI-summary
generation is a separate, longer-running, partly-async path this load
test's request/response model doesn't naturally cover. A real regression
test against these targets (the story's own AC requires one before closing)
is still open work, not just a documentation gap.

## Alert-worthy events

Per Task 12 of the remediation plan, these are the events an operations dashboard/alerting
rule should be built around (no metrics/tracing platform is wired into this codebase yet —
see Notes below; this table is the specification for whoever adds one):

- **Database outage or exhaustion** — `/api/health/db` returns non-200, or app logs contain
  `PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.`
  (connection-pool exhaustion — reproduced for real in the run below).
- **Redis outage** — `/api/health/redis` returns non-200 (rate limiting silently no-ops when
  Redis is down; see `src/redis/redis.service.ts` and `src/common/guards/rate-limit.guard.ts`).
- **Rate-limit degradation** — a sustained spike in `429` responses on `/api/auth/login` or any
  other `@RateLimit`-guarded route, which would indicate either an abuse pattern or a
  misconfigured limit.
- **SMS/Gemini timeout** — `SmsService`/`AiService` logging a timeout error (`SMS_TIMEOUT_MS`/
  `GEMINI_TIMEOUT_MS`, added in Tasks 7/of this remediation pass) — an outbound-dependency
  degradation, not a bug in this app.
- **Export failure** — a non-200 on any `/export`, `/survey-responses/export`, or
  `/survey-responses-full` route, or a request that runs long enough to suggest the
  `MAX_EXPORTABLE_RESPONSES` (50,000, Task 8) cap is being hit routinely (a signal the cap or a
  real streaming implementation needs revisiting).
- **Repeated 5xx responses** — any sustained (not one-off) run of `AllExceptionsFilter`-logged
  errors, as opposed to expected 4xx (validation/auth) responses.

## Result (2026-07-14, single instance on the dev box; Postgres over TLS 1.3)

Sustained phase: 15 s warmup @3 + 120 s @8 new VUs/s.

| Metric | Result | Budget | Verdict |
|--------|--------|--------|---------|
| Requests | 9,045 (all HTTP 200) | — | — |
| Throughput | **77 req/s** sustained | 30–50 | ✅ |
| Latency p50 | 24.8 ms | — | — |
| Latency **p95** | **210.6 ms** | < 500 ms | ✅ (~2.4× headroom) |
| Latency p99 | 308 ms | — | ✅ |
| Max | 702 ms | — | — |
| VUs completed / failed | 1,005 / **0** | — | — |
| **Error rate** | **0 %** | < 1 % | ✅ |
| Full-scenario (login→8 reads) p95 | 671.9 ms | — | — |

**PASS.** At pilot volume (50 entities / 500 users) the per-request RLS + pagination
path sustains 77 req/s with a p95 of ~211 ms and zero errors — comfortably within
budget, so **no caching layer is required at this scale**. New entities are added
purely by inserting rows (see `load-seed.ts` and public signup), with no schema
change — satisfying "growth without rebuild."

## Result (2026-07-27, single instance on the dev box, after adding the write scenario)

Re-run to validate `auth-then-write` (Task 12 of the backend remediation pass) and to gather
real operational evidence for that pass's Task 12. Same phases (15 s warmup @3, 120 s @8) against
the local dev Postgres (not a production-like/dedicated instance — this box also runs other dev
services, so the numbers below are directional, not a clean baseline).

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Requests | 7,481 | — | — |
| Throughput | 61 req/s | 30–50 | ✅ |
| Latency p95 | 4,403.8 ms | < 500 ms | ❌ |
| Latency p99 | 7,260.8 ms | < 1000 ms | ❌ |
| Error rate | (361×403 + 3×429 + 333×500 + 150 failed captures) / 7,481 ≈ 11.4 % | < 1 % | ❌ |
| vusers completed / failed | 855 / 150 | — | ❌ |

**FAIL, with a root cause identified for the 5xx errors — not a regression from this remediation
pass's own code changes.** All 333 `5xx` responses are the identical error:
`PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given
time.` — Postgres connection-pool exhaustion under concurrency, reproduced on both the pre-existing
`GET /api/organizations/current` read and the new `PATCH /api/users/:id` write. This local dev
Postgres container (`max_connections: 100`) is shared with three separate Prisma-client instances
per request path (`cnap_owner`/`cnap_app`/`cnap_supervisor`, per `TenantPrismaService`), and was
already flagged as an open follow-up in this file's 2026-07-14 result ("connection-pool sizing...
is follow-up work") — this run is the first time it was actually load-tested and reproduced. A
smaller number of `403 FORBIDDEN` responses appeared exclusively on the new write scenario's
`PATCH` calls; **the original hypothesis here — that these were a downstream symptom of DB
contention — was disproven by the 2026-07-27 (Redis-enabled) re-run below**, which had fewer 5xx
but *more* 403s. See that section for the corrected analysis.

**Action items for whoever picks up connection-pool sizing (pre-existing follow-up, now with a
reproduction):**
- Increase Postgres `max_connections` and/or add `connection_limit`/`pool_timeout` query params to
  each of the three `DATABASE_URL`s (`APP_DATABASE_URL`, `SUPERVISOR_DATABASE_URL`, owner), sized
  for `(expected concurrent requests) × (3 role-scoped clients)`.
- Re-run this exact scenario after that change and confirm the `Unable to start a transaction in
  the given time` error disappears.
- Only once a real Postgres/Redis instance sized for production is available should this become a
  pass/fail gate against the Acceptance thresholds table above, run in a production-like
  environment as Task 12 of the remediation plan specifies — this dev-box run is evidence of a real
  finding, not a substitute for that.

## Result (2026-07-27, same dev box, with Redis actually configured)

Re-run after wiring a local Redis instance in via `REDIS_URL` (previously unset, so the first run
above had no Redis at all — `RateLimitGuard` fell back to an unshared in-memory counter per Nest
app instance). Same phases, same seed volume.

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Requests | 8,321 | — | — |
| Throughput | 31 req/s | 30–50 | ✅ |
| Latency p95 | 1,043.3 ms | < 500 ms | ❌ (improved from 4,403.8 ms) |
| Latency p99 | 4,492.8 ms | < 1000 ms | ❌ (improved from 7,260.8 ms) |
| Error rate | (388×403 + 1×429 + 79×500 + 42 failed captures) / 8,321 ≈ 6.1 % | < 1 % | ❌ (improved from ~11.4 %, but see below) |
| vusers completed / failed | 963 / 42 | — | ❌ |

**Redis itself worked correctly and as designed**: `/api/health/redis` → 200 throughout, `redis-cli
info clients` showed 2 connected clients from the app (well within `maxclients: 10000`), and
`redis-cli --scan --pattern "rio:rate:*"` found 231 real, correctly-namespaced rate-limit keys —
this is genuine evidence Task 6/7's Redis-backed rate limiting works end-to-end, not just in unit
tests.

**The connection-pool-exhaustion 500s dropped (333 → 79)**, consistent with less overall pressure
on that specific failure mode this run. **But the write-path 403s got *worse*, not better (194 of
~205 write attempts vs. ~4 in the first run)** — disproving the first run's hypothesis that they
were a downstream symptom of DB contention. Follow-up investigation this session:
- A single sequential `PATCH /api/users/:id` request against a freshly-logged-in account: **200,
  succeeds every time.**
- A 30-way *concurrent* burst of the same request against 30 different accounts, all in parallel:
  **30/30 succeed.** This rules out a simple one-shot concurrency race.
- Ruled out `RateLimitGuard`: that route has no `@RateLimit()` decorator, and its failure mode is a
  429 with a `RATE_LIMITED` code, not a 403.
- Ruled out `CsrfGuard`: it only enforces on cookie-authenticated requests; this load client only
  ever sends a Bearer token, never the session cookie.
- The 403 itself comes from `PermissionGuard` (`{ error: { code: 'FORBIDDEN' } }`), which checks
  `getOrgStore()?.role`. `role_ngo_admin` has `fullAccess()`, so this can only happen if the
  request's org-context `role` is unset or wrong at the point `PermissionGuard` runs —
  `JwtAuthGuard` is what sets it, after its own `runAsSupervisor` DB round-trip.
- **Unresolved**: only *sustained* load (not a one-shot burst) reproduces it, and it hits the write
  scenario overwhelmingly more than the read scenario's own `GET` calls in the very same VU
  iteration (which succeed). This doesn't fit a generic `AsyncLocalStorage` context-loss theory
  (that would hit reads too) as cleanly as it first seemed. Root-causing this properly needs
  request-level tracing under load — which doesn't exist in this codebase (see the Notes section
  below) — not more manual `curl`/burst experiments. **Documented here as a real, reproducible,
  still-open finding**, not fixed and not swept under the earlier (disproven) explanation.
- **Side effect found and reverted**: leaving `REDIS_URL` set in `.env` after this run made
  rate-limiting genuinely shared across the parallel e2e test suite (multiple spec files reuse the
  same seeded `admin@demo-ngo.org` login), causing 9 unrelated e2e tests to fail with 429s on the
  next `pnpm test` run. `REDIS_URL` was removed from `.env` again immediately after capturing the
  measurements above, the leftover `rio:rate:*` keys were flushed, and the full suite was confirmed
  back to 320/320. This is itself worth fixing before Redis is wired into local dev by default
  (e.g. distinct seeded logins per e2e spec file, or a global test-setup hook that flushes
  rate-limit keys).

## Result (2026-08-27, real 500-*concurrent*-session re-test — RIO-NFR-005 Round 5)

Every result above tested 50 orgs × 500 *total registered* accounts under light arrival-rate
traffic (peak concurrency well under 100 VUs) — not what the client actually confirmed as the
pilot target. Round 5 (2026-08-24) corrected this: the real target is **500 concurrent
users/sessions**. `pilot.yml`'s phases were re-sized (`arrivalRate` × average session length ≈
500 concurrent) to `warmup(10s@15/s) → ramp(20s, 15→210/s) → sustained(60s@210/s)`, same
50-org/500-account seed, same two scenarios/weights, same thresholds. Single dev-box instance,
same as every run above — this is not a production-sized deployment.

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| VUs created | 15,000 | — | — |
| VUs completed / failed | 860 / 14,140 | — | ❌ **94% of virtual users failed to complete** |
| Requests | 21,534 | — | — |
| HTTP 200 | 2,946 (14% of requests) | — | ❌ |
| HTTP 500 | 6,032 | — | ❌ |
| HTTP 429 (rate-limited) | 303 | — | — |
| HTTP 403 | 258 | — | — |
| `ETIMEDOUT` errors | 11,995 | — | ❌ |
| Latency p95 | 9,416.8 ms | < 500 ms | ❌ (19x over budget) |
| Latency p99 | 11,050.8 ms | < 1000 ms | ❌ |
| Error rate | ≈ 69% of responses non-200 | < 1 % | ❌ |

**The system does not hold up at the real confirmed pilot scale.** Every prior run on this page
found the connection-pool-exhaustion (`PrismaClientKnownRequestError: Transaction API error:
Unable to start a transaction in the given time`) failure mode confined mostly to the *write*
path under light concurrency. At real 500-concurrent load, the server log shows the identical
error now hitting **read-only endpoints just as hard** — `AuthService.me`,
`OrganizationsService.getCurrent`, `UsersService.list`, and `AuditService.list` all failed with
it repeatedly (12,400+ matching log lines during the run). Root cause is unchanged from earlier
findings — Prisma's default connection-pool size vs. Postgres `max_connections` (100 on this dev
box) — but the *severity* is materially worse than anything measured before: at the old
light-arrival scale, reads passed cleanly at ~211ms p95 with zero errors; at genuine 500-concurrent
scale, the same read endpoints collapse alongside the write path.

**No response-time target can responsibly be proposed from this result** — the system fails
functionally (94% VU failure) long before latency becomes the binding constraint. **What this
confirms, concretely, for the client conversation:**
1. Connection-pool sizing must be fixed (and re-tested) before any pilot deployment at this scale,
   not treated as a nice-to-have — this is not a hypothetical concern, it's reproduced here.
2. The 7,000+ target-NGO figure the client separately flagged is **more than an order of magnitude
   beyond a scale this dev-box configuration already fails at** — the connection-pool fix and the
   production sizing/architecture conversation are not two separate follow-ups, they're the same
   one, and it needs to happen before either number is treated as achievable.
3. This dev-box run (single Postgres instance, default pool settings, no PgBouncer/connection
   pooler in front of it) is not evidence of what a properly sized production deployment would do
   — but it is real evidence that the *current default configuration* cannot be assumed to scale
   linearly from the old light-traffic numbers.

## Fix attempt (2026-08-27, same day) — pool-size fix applied, real but partial improvement; a deeper bottleneck found

**Root cause identified:** `PrismaService`/`SupervisorPrismaService` (`src/prisma/*.ts`) each wrap
a `pg.Pool` via `@prisma/adapter-pg` without setting `max` — `pg.Pool`'s undocumented default is
**10 connections**. Every request, even a plain read, opens its own interactive transaction
(`TenantPrismaService.runInOrgContext`, for the per-request RLS `app.current_org_id`), so this
10-connection ceiling was the app's real concurrency limit regardless of Postgres's own
`max_connections=100`.

**Fix applied:** added `DB_POOL_MAX_APP` (default 60) / `DB_POOL_MAX_SUPERVISOR` (default 15) env
vars (`env.schema.ts`), wired into both pools' `PrismaPg({ max: ... })` config. Re-ran the exact
same 500-concurrent scenario:

| Metric | Before fix | After pool fix | Budget |
|---|---|---|---|
| HTTP 200 | 2,946 | 4,951–5,890 (varied by run) | — |
| `Unable to start a transaction` errors | 6,032 | 3,980–4,263 | — |
| VUs failed (of 15,000) | 14,140 (94%) | 13,856–14,068 (~92–93%) | — |
| Latency p95 | 9,417 ms | 7,866–9,048 ms | < 500 ms |

**Real improvement, not nothing** — roughly 30% fewer connection-pool-timeout errors and up to 2x
more successful requests. **But the system still fails at real 500-concurrent scale after this
fix.** Investigated why: `/api/auth/login` itself was taking a **~2.2 second median** response
time (should be ~50–150ms for a single argon2id verify) — a sign of severe queueing on the login
path specifically, independent of the DB pool. Hypothesis: `argon2`'s async verify runs on
libuv's threadpool (default size 4), so 15,000 concurrent fresh logins queue on very few worker
threads. Tested by re-running with `UV_THREADPOOL_SIZE=32` (8x default) — **no measurable
improvement** (median login latency unchanged at ~2.17s, VU failures unchanged at ~93%). This
rules out thread-pool size as the bottleneck; **`UV_THREADPOOL_SIZE` was not committed to the
codebase** since it demonstrably didn't help.

**Conclusion: the remaining bottleneck is raw CPU capacity for argon2id password hashing under a
15,000-concurrent-fresh-login storm, on this dev box's 8 physical cores** — argon2id is
deliberately memory-hard and CPU-expensive (that's the point, for password security), and no
amount of thread-count tuning changes how many hashes 8 cores can compute per second. This is a
genuine hardware/capacity constraint, not an application misconfiguration:
- It is very likely to look materially better on real production-grade server hardware with more
  cores, and/or with the auth-path work spread across multiple horizontally-scaled app instances.
- Artillery's scenario (every one of 15,000 VUs performs a **brand-new** login) is a legitimate
  worst case, but is harsher than most real usage, where an already-authenticated user's session
  token is reused across requests rather than re-logging in — so "500 concurrent users" in
  practice generates far fewer fresh logins per second than this test does. This doesn't erase the
  finding (the read/write collapse under real concurrency is still real signal, and the pool fix
  was still necessary and correct), but it means the specific 500-concurrent-*login-storm* number
  overstates one dimension of the real-world load shape.
- **Not yet tried**: capping/queuing concurrent argon2 work explicitly (e.g., a small worker pool
  with backpressure) rather than lettings 15,000 requests all hit `argon2.verify` at once, and
  re-testing on cloud-grade multi-core hardware instead of this dev laptop. Both are legitimate
  next steps before concluding the *application* still fails at scale — this run only proves this
  *dev-box configuration* does.

**Kept in the codebase:** the pool-size fix (`DB_POOL_MAX_APP`/`DB_POOL_MAX_SUPERVISOR`) — it is
correct and necessary regardless of the deeper CPU finding, and measurably reduced one real
failure mode. **Not kept:** the `UV_THREADPOOL_SIZE` experiment — no evidence it helps.

## Notes / next steps
- This is a functional pilot-scale load test on a single app instance + one Postgres.
  Production capacity planning (horizontal scaling, connection-pool sizing — now reproduced above,
  not just theorized — a soak/endurance run, and load against the Week-2/3 assessment-pipeline
  endpoints) is follow-up work as those features and real traffic profiles land.
- Login (argon2id) is intentionally CPU-costly; the scenario logs in once per VU and
  reuses the token so the measurement reflects the data-layer (RLS) scalability, not
  the fixed auth cost.
- **Metrics/tracing platform**: this codebase has no APM/tracing library wired in (only
  structured `nestjs-pino` request logs — see README.md's Observability section). Task 12 of the
  remediation plan calls for "metrics/tracing hooks using the project's selected operations
  platform" — no such platform has been selected, so this was **not implemented** in this pass.
  The Alert-worthy events table above is written as the specification for whoever picks a platform
  (Prometheus/Grafana, Datadog, etc.) and wires it in.
- **Redis**: the first (2026-07-14 read-only, and 2026-07-27 with-writes) runs had no Redis
  configured at all (`REDIS_URL` unset) — `RedisService` had no client, `/api/health/redis`
  correctly reported unavailable, and rate limiting silently no-opped rather than blocking
  requests (Task 6 fail-open behavior, working as designed). The second 2026-07-27 run above
  *did* exercise a real (ambient, non-production) local Redis instance and captured genuine
  connection/rate-limit-key evidence — see that section. `REDIS_URL` is deliberately left unset in
  the committed `.env` afterward (see that section's "side effect" note) — this is a config choice
  for local dev/test stability, not an oversight.
- **Sign-off**: this file records engineering evidence only. Security/backend/QA/operations
  sign-off (the last item of Task 12 and the remediation checklist's Sign-Off section) is an
  organizational step this environment cannot perform — see the final checklist for the honest
  status of that item.
