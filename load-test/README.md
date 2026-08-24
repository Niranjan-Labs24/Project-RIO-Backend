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
it). The targets below are **internally set working targets, not yet
client-confirmed** — proceeding with these so the story isn't blocked, to be
verified with the client once possible.

| Metric | Internal target | Basis |
|---|---|---|
| Dashboard load (Priority Dashboard, System Admin Dashboard, etc.) | < 3 seconds | Standard web-app responsiveness bar; the `p95 latency < 500 ms` API threshold above is the main contributor and is already enforced automatically — the remaining budget is frontend render time |
| Report generation (PDF/Excel, non-AI content) | 10–15 seconds | Observed typical generation time for the existing report types |
| Report generation involving an AI-generated summary (executive/combined summaries) | up to 60 seconds | LLM-call latency dominates; not meaningfully reducible without changing the summarization approach |
| Pilot data-volume assumption these targets are tested against | 50 orgs × 500 users | Same scale already established and seeded by `load-seed.ts` for the NFR-006 run above — reused rather than inventing a second scale |

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
