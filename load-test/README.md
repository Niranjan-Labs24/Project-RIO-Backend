# RIO-NFR-006 — Scalability load test

Proves the scalability claim (row-per-entity multitenancy + per-request RLS +
bounded pagination scale at pilot volume **without rebuild**) with a real
Artillery run against a running API seeded to pilot scale.

## Files
- `load-seed.ts` — seeds **50 orgs × 10 NGO-Admin users (500 accounts)** and writes `users.csv`.
- `pilot.yml` — Artillery scenario: `login` (once) → loop×2 `[me, organizations/current, users, audit]`. Every read runs inside a per-request RLS transaction — the thing that must scale.
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

## Notes / next steps
- This is a functional pilot-scale load test on a single app instance + one Postgres.
  Production capacity planning (horizontal scaling, connection-pool sizing, a
  soak/endurance run, and load against the Week-2/3 assessment-pipeline endpoints)
  is follow-up work as those features and real traffic profiles land.
- Login (argon2id) is intentionally CPU-costly; the scenario logs in once per VU and
  reuses the token so the measurement reflects the data-layer (RLS) scalability, not
  the fixed auth cost.
