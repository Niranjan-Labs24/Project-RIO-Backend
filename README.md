# cnap-api

NestJS 11 backend for the Community Needs Assessment Platform (MVP). Foundational base:
multi-tenant RLS isolation, boot-time config validation, contract-first (TypeBox → OpenAPI),
one worked example module (`notes`).

## Prerequisites
- Node 24 LTS, pnpm 10, Docker Desktop

## Quick start (local dev, app runs on the host)
```bash
pnpm install
cp .env.example .env
pnpm db:up                       # postgres:18 + provisions cnap_owner / cnap_app roles
pnpm prisma migrate deploy       # apply schema + RLS
pnpm prisma:seed                 # optional demo data (Org A / Org B)
pnpm dev                         # http://localhost:3000  (docs at /docs, spec at /openapi.json)
```
`pnpm dev` (and `node dist/main.js`) load `.env` automatically via `dotenv/config` (the first import
in `src/main.ts`), so no separate `export $(cat .env)`-style step is needed — just make sure `.env`
exists (`cp .env.example .env`) before starting the app. In production, when no `.env` file is
present, this is a harmless no-op — config comes from the environment (compose/CI) instead.

If your host already has PostgreSQL bound to port 5432 (e.g. a native Windows service), set
`DB_HOST_PORT=<free port>` in `.env` and update the two `*_URL` values to match — docker compose
auto-reads `.env` for the `${DB_HOST_PORT:-5432}` substitution in `docker-compose.yml`.

### Local development vs. production Compose
`docker-compose.yml` on its own is the production-safe definition: it has no default database
password and no default `db`/`api` connection strings, and does not publish the database to a host
port at all — `docker compose config` fails closed (`POSTGRES_PASSWORD must be set`, etc.) unless
those are actually provided. `docker-compose.dev.yml` is a small override that only re-adds the
database's host port publish for local tooling (psql, a GUI client). `pnpm db:up`/`pnpm db:down`
already apply both files (`docker compose -f docker-compose.yml -f docker-compose.dev.yml ...`), so
local development needs no extra commands.

The actual dev-only credentials (`POSTGRES_PASSWORD`, `DOCKER_APP_DATABASE_URL`,
`DOCKER_SUPERVISOR_DATABASE_URL`) come from `.env` — which docker compose auto-loads for variable
substitution — not from `docker-compose.dev.yml` itself; see `.env.example`'s comments. A real
deployment simply doesn't ship that `.env` file and supplies its own values through whatever
secret-injection mechanism it uses (the same pattern `JWT_SECRET` already used before this).

**Credential rotation for a real deployment:** `db/init/00-init.sql` and the
`20260713031212_rls_domain` migration hardcode the initial `cnap_owner`/`cnap_app`/`cnap_supervisor`
role passwords (`*_dev_pw`) — this is unavoidable for a from-scratch `prisma migrate deploy` against
an empty database, since Prisma migrations are immutable history and can't read a runtime secret.
Any real deployment must rotate these immediately after the first `prisma migrate deploy`:
```sql
ALTER ROLE cnap_owner WITH PASSWORD '<new-random-secret>';
ALTER ROLE cnap_app WITH PASSWORD '<new-random-secret>';
ALTER ROLE cnap_supervisor WITH PASSWORD '<new-random-secret>';
```
then update `DATABASE_URL`/`APP_DATABASE_URL`/`SUPERVISOR_DATABASE_URL` (and
`DOCKER_APP_DATABASE_URL`/`DOCKER_SUPERVISOR_DATABASE_URL` if using Compose) to match before
starting the app against that database.

### Env vars (see `.env.example` for full defaults/comments)
- `CORS_ORIGIN` — single frontend origin allowed to send credentialed (cookie) requests. Defaults to
  `http://localhost:3000`; credentials mode forbids a wildcard, so this must be an exact origin.
- `RESEND_API_KEY` — Resend API key for the signup temporary-password/password-reset/survey-link
  emails. Leave unset to disable email entirely: signup then falls back to returning/logging the
  temp password, but **only** outside production (`NODE_ENV` defaults to `production` when unset,
  so this fallback fails closed by default).
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` — Twilio SMS for the citizen
  survey's mobile OTP. `TWILIO_FROM_NUMBER` must be a number actually provisioned on that Twilio
  account, in E.164 format. Leave `TWILIO_ACCOUNT_SID` unset to disable SMS entirely — same
  dev-only fallback as email.
- `MAIL_FROM` — the `From:` address/display name used for that email (default `RIO <no-reply@rio.local>`).
- `CSRF_ENFORCE` — double-submit CSRF check for cookie-authenticated mutations (`CsrfGuard`). **Default `true`**; the
  frontend must first read the `rio_csrf` cookie and echo it as `X-CSRF-Token` on unsafe methods
  whenever it uses the session cookie. `login`/`signup` are always exempt (they issue that cookie). Even
  with this on, cross-site (different-site frontend/API) deployments additionally need
  `sameSite: 'none'` on the session/CSRF cookies (`session-cookie.ts`) — that is a separate,
  not-yet-automated deploy-config step, out of scope for the guard itself.

## Running the whole stack in Docker (db + api)
```bash
pnpm db:up                       # start Postgres first
pnpm prisma migrate deploy       # apply schema + RLS from the host — see "Migrations in Docker" below
docker compose up -d --build     # builds and starts the api image (db is already up)
curl http://localhost:4000/health
curl http://localhost:4000/health/db
curl http://localhost:4000/openapi.json
pnpm db:down                     # add -- -v to also drop the db volume
```
Applying migrations before the `api` container starts (or at least before hitting any non-health
endpoint) matters: `/health` responds without touching the database, but `/health/db` and every
other route need the schema in place first — an `api` container started against an unmigrated
database will error on those routes until `pnpm prisma migrate deploy` has run.
The `api` service publishes host port 3000 by default; set `API_HOST_PORT` in `.env` if that's
already taken. Inside the compose network `api` always reaches Postgres at `db:5432` — the
`DB_HOST_PORT` override only affects the *host*-published port used by tools like the Prisma CLI
running outside the containers.

### Migrations in Docker
The `api` image is a production (`pnpm install --prod`) image: it deliberately does **not**
include the `prisma` CLI, `prisma.config.ts`, or the `prisma/` source directory — those are
dev-only tooling the running app never touches (`PrismaService` talks to Postgres directly via the
`@prisma/adapter-pg` driver adapter using the pre-generated client baked into `dist/generated/prisma`
at build time; no query-engine binary or CLI is needed at runtime). Consequently the `api`
container does **not** run migrations on startup. Apply schema changes with the Prisma CLI from the
host (pointed at the host-published db port) before or after `docker compose up -d api`:
```bash
pnpm prisma migrate deploy
```
This mirrors local dev, where migrations are always applied the same way regardless of whether the
api process itself runs on the host or in a container.

## Tenant isolation model (AD-1 / AD-15)
- Every tenant table has `org_id`; PKs default to PG18 `uuidv7()`.
- The app connects as **cnap_app** (`NOBYPASSRLS`). Tenant tables are `FORCE ROW LEVEL SECURITY`.
- The **tenancy layer is the only sanctioned query surface**: `TenantPrismaService.runInOrgContext`
  opens one interactive transaction and sets `app.current_org_id` via `set_config(..., true)`.
- Policies **fail closed**: no org context ⇒ zero rows.
- `DATABASE_URL` (cnap_owner) is for the Prisma CLI only; `APP_DATABASE_URL` (cnap_app) runs the app.

## Auth
Auth is live: an httpOnly `rio_session` cookie carries a signed JWT (`JWT_SECRET`/`JWT_EXPIRES_IN`),
set on `POST /api/auth/login` and `POST /api/auth/signup`. Requests may also send the same JWT as a
`Authorization: Bearer <token>` header — both are read (cookie first, then Bearer as a fallback for
non-browser clients), so either works.

- `POST /api/auth/signup` — public NGO self-registration (org + first NGO Admin + consent record).
  Issues a temporary password: emailed via SMTP when configured (see below), otherwise — outside
  production only — returned in the response body (`temporaryPassword`) and logged, so nothing ever
  leaks the temp password in a production response.
- `POST /api/auth/change-password` — the signed-in user replaces their current password
  (`mustChangePassword` is forced `true` after signup, so the frontend should route straight to this
  screen until it's cleared).
- `GET /api/auth/me`, `POST /api/auth/logout` — re-check org active state / drop the session cookie.

`login` and `signup` are exempt from CSRF checks (see below) because they *issue* the CSRF cookie
rather than consume an existing session — see `@CsrfExempt()` in `auth.controller.ts`.

Auth is stateless (no server-side session/denylist): a token already issued stays valid until it
expires even if the org is deactivated or the user's role changes afterwards. Keep `JWT_EXPIRES_IN`
short in security-sensitive deployments.

### ⚠️ Dev-only auth seam
`OrgContextMiddleware` also reads `x-org-id` (and `x-role`) to set the org/role directly, bypassing
the cookie/JWT above. This seam exists **only** for local testing against modules that don't yet
enforce real auth — it is **not** a second production auth mechanism. It is unavailable in production
by construction (`NODE_ENV` fails closed to `production` when unset — see `env.schema.ts`).
Example: `curl -H "x-org-id: <org-uuid>" http://localhost:3000/notes`.

## Observability
The app logger is `nestjs-pino` (structured JSON via pino), wired in `AppModule` and installed as
Nest's logger in `main.ts` (`app.useLogger(app.get(Logger))`), so both direct app logs and Nest's
built-in `Logger` (e.g. inside `AllExceptionsFilter`) are routed through it. Every log line is
enriched with the request's correlation id and, once tenant context is established, the org id
(`requestId` / `orgId`, sourced from the async-local-storage-backed org context) — never request
bodies or the `authorization`/`cookie`/`x-org-id` headers, which are redacted.

## Operational runbook
- **Database unavailable**: `/api/health/db` returns 503 without leaking the driver error/hostname
  to the client (logged server-side only, Task 6 of the backend remediation pass). Recovery: check
  `docker compose ps db` / the managed Postgres instance's own health; the app retries per-request,
  no restart needed once the DB is back.
- **Redis unavailable**: `/api/health/redis` returns 503; `RateLimitGuard` silently no-ops (fails
  open, not closed) rather than blocking all traffic — see `src/redis/redis.service.ts`. Recovery:
  restart/restore Redis; no app restart needed, it reconnects.
- **SMS/Gemini provider timeout**: bounded by `SMS_TIMEOUT_MS`/`GEMINI_TIMEOUT_MS` (Task 7) — a
  timeout surfaces as a normal error response to the caller, logged server-side with the phone
  number/prompt redacted, never blocking the event loop indefinitely.
- **Connection-pool exhaustion**: see `load-test/README.md`'s 2026-07-27 result — a real,
  reproduced failure mode under concurrent load in this environment
  (`PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the
  given time.`), not yet fixed (tracked there as a follow-up, consistent with the pre-existing
  "connection-pool sizing" note in that file).
- **Load-test acceptance thresholds and alert-worthy events**: documented in
  `load-test/README.md` (p95/p99, error rate, heap, DB/Redis connection budgets). No metrics/
  tracing platform is wired into this codebase yet — that file's Notes section is the honest status
  of that gap, not a claim that it's done.

## Error envelope
Uncaught exceptions and thrown `HttpException`s are normalized by a global `AllExceptionsFilter`
(wired in `main.ts` via `app.useGlobalFilters`) into `{ error: { code, message, details? } }`.

## Testing
```bash
pnpm test   # unit + e2e; includes the cross-tenant isolation gate (requires the Docker DB)
```

## CI
`.github/workflows/ci.yml` spins up a `postgres:18` service container, provisions the
`cnap_owner` / `cnap_app` roles and the `cnap` database with the same `db/init/00-init.sql` script
the local `db` container runs automatically, applies migrations, generates the Prisma client, then
runs lint, build, and the full test suite (including the cross-tenant isolation gate) as the merge
gate.

## Deferred (later phases)
pg-boss jobs · ports/adapters (LLM/storage/email) · auth hardening (token revocation/refresh,
password reset) · scoring engine · AiDecision provenance · reference-data versioning · the 12
feature modules. (Login/signup/change-password auth and a basic audit trail are already live —
see "Auth" above.)
