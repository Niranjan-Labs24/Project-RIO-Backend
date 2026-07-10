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
docker compose up -d db          # postgres:18 + provisions cnap_owner / cnap_app roles
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

## Running the whole stack in Docker (db + api)
```bash
docker compose up -d db          # start Postgres first
pnpm prisma migrate deploy       # apply schema + RLS from the host — see "Migrations in Docker" below
docker compose up -d --build     # builds and starts the api image (db is already up)
curl http://localhost:3000/health
curl http://localhost:3000/health/db
curl http://localhost:3000/openapi.json
docker compose down              # add -v to also drop the db volume
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

## ⚠️ Dev-only auth seam
`OrgContextMiddleware` reads `x-org-id` to set the org for local testing. This is **not** production
auth — real auth (Passport/Argon2/session, deriving org from the session/token) is a later phase.
Example: `curl -H "x-org-id: <org-uuid>" http://localhost:3000/notes`.

## Observability
The app logger is `nestjs-pino` (structured JSON via pino), wired in `AppModule` and installed as
Nest's logger in `main.ts` (`app.useLogger(app.get(Logger))`), so both direct app logs and Nest's
built-in `Logger` (e.g. inside `AllExceptionsFilter`) are routed through it. Every log line is
enriched with the request's correlation id and, once tenant context is established, the org id
(`requestId` / `orgId`, sourced from the async-local-storage-backed org context) — never request
bodies or the `authorization`/`cookie`/`x-org-id` headers, which are redacted.

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
pg-boss jobs · ports/adapters (LLM/storage/email) · full auth internals · scoring engine ·
audit trail · AiDecision provenance · reference-data versioning · the 12 feature modules.
