# CNAP API — Architecture

Backend for the Community Needs Assessment Platform (Rio). A multi-tenant, RBAC-guarded NestJS service. This document describes the structure, invariants, and extension points so the system can be modified without unintended impact (RIO‑NFR‑013 Maintainability).

## 1. Tech stack

| Concern | Choice |
|---------|--------|
| Runtime | NestJS 11 · Node 24 LTS · TypeScript 5 (strict, `noUncheckedIndexedAccess`) |
| Data | PostgreSQL 18 · Prisma 7 (driver-adapter `@prisma/adapter-pg`; client generated to `src/generated/prisma`) |
| Identity | argon2id password hashing · stateless JWT bearer (`@nestjs/jwt`) |
| Isolation | PostgreSQL Row-Level Security (RLS) + 3 DB roles |
| Config | TypeBox + AJV env validation (fail-safe: unset `NODE_ENV` ⇒ production) |
| Logging | `nestjs-pino` (structured, request-id correlated) |
| Testing | Vitest 4 (unit) + supertest (e2e against a real Docker DB) |
| Packaging | pnpm · Docker Compose (Postgres) |

## 2. Layered request lifecycle

```
HTTP → OrgContextMiddleware → JwtAuthGuard → PermissionGuard → Controller → Service → TenantPrismaService → Postgres (RLS)
        (creates OrgStore:        (bearer →      (@RequirePermission                     (runInOrgContext /
         requestId, ip, ua,        OrgStore)      vs OrgStore.role)                        runAsOrg / runAsSupervisor)
         dev x-org-id/x-role)
```

- **`OrgStore`** is an `AsyncLocalStorage` record carrying `{ requestId, orgId?, actorId?, role?, ip?, userAgent? }` for the life of a request. Everything downstream reads it instead of threading context through call signatures.
- **`JwtAuthGuard`** (global, runs first) verifies a `Bearer` token and populates `OrgStore`. Absent token ⇒ non-blocking (in non-prod the `x-org-id`/`x-role` dev seam is the fallback; in prod the store stays empty and access is denied). Invalid token ⇒ 401.
- **`PermissionGuard`** (global, runs second) enforces `@RequirePermission(module, action)` against `OrgStore.role` using the fixed `ROLE_MATRIX`. Routes without the decorator are unconstrained (health, login).

## 3. Core invariants (do not break these)

1. **Tenant isolation is the DB, not the app.** Every tenant table has `FORCE ROW LEVEL SECURITY` with a fail-closed policy `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. Unset/empty org context ⇒ zero rows, never an error. Repositories/services touch the DB **only** through `TenantPrismaService`.
2. **Least privilege.** The app never holds owner credentials. Three roles: `cnap_owner` (CLI migrate/seed only), `cnap_app` (runtime, NOBYPASSRLS, DML on tenant tables), `cnap_supervisor` (runtime, NOBYPASSRLS, SELECT-only cross-org). `audit_logs` is append-only for `cnap_app` (SELECT+INSERT, no UPDATE/DELETE).
3. **RBAC is one source of truth.** `src/rbac/role-matrix.ts` (`ROLE_MATRIX`, 9 roles × 12 modules × 6 actions) is seeded into `roles`/`role_permissions` *and* read in-memory by the guard, so DB and enforcement cannot drift. Roles are read-only (`GET /api/roles`); no in-app role authoring.
4. **Audit is append-only and captures before/after.** Mutating services call `AuditService.record()` with `changes[{field,before,after}]`; rows carry actor, ip/ua, and timestamp.
5. **Consistent error envelope.** `AllExceptionsFilter` emits `{ error:{code,message}, message, code }` — a top-level `message` the FE client reads (DV-8).
6. **API surface.** Global `/api` prefix, port 4000; response body IS the raw payload (no wrapper). Enum casing matches the FE verbatim (`Sector` lowercase, `UserStatus` active|invited, camelCase permission modules).

## 4. Tenancy access paths (`TenantPrismaService`)

| Method | Use when | Role |
|--------|----------|------|
| `runInOrgContext(fn)` | Ambient authenticated read/write, scoped to the caller's org | `cnap_app` |
| `runAsOrg(orgId, fn)` | Explicit-org bootstrap (org creation, login counters) | `cnap_app` |
| `runAsSupervisor(fn)` | crossEntity cross-org **reads** (system_admin, center_supervisor); pre-context login lookup | `cnap_supervisor` |

## 5. Module map

```
src/
  config/        env schema (TypeBox+AJV) + ConfigService        — validated settings
  common/        filters (error envelope), guards (PermissionGuard), logger
  tenancy/       OrgStore (ALS), middleware, TenantPrismaService  — isolation layer
  prisma/        PrismaService (cnap_app), SupervisorPrismaService (cnap_supervisor)
  rbac/          ROLE_MATRIX + can() helper                       — authorization source of truth
  auth/          PasswordService (argon2), TokenService (JWT), JwtAuthGuard
  health/        liveness
  contract/      OpenAPI doc + TypeBox registry
  modules/
    roles/         GET /api/roles                                 (TEA-1)
    auth/          login/me/logout/consent + SessionContext       (R3)
    audit/         AuditService.record + GET /api/audit           (R6 / TEA-6, NFR-004)
    organizations/ current/update/listAll/getById/createWithAdmin (R4)
    users/         list/invite/update (+ cross-org)               (R5)
prisma/          schema.prisma, migrations (init_domain, rls_domain), seed.ts
test/            e2e specs (real DB) + helpers
```

Each feature module owns one responsibility and communicates through typed service interfaces + the shared `TenantPrismaService`/`AuditService`. Files that change together live together (types + service + controller + module per feature).

## 6. Extension points — adding a feature module

1. `src/modules/<feature>/`: `<feature>.types.ts`, `<feature>.service.ts` (inject `TenantPrismaService`, `AuditService`), `<feature>.controller.ts` (annotate each route with `@RequirePermission(module, action)`), `<feature>.module.ts`.
2. Reads/writes go through `TenantPrismaService`; cross-org reads use `runAsSupervisor` + a `crossEntity` check.
3. Every mutation calls `AuditService.record(...)` with `entityType`, `entityId`, `entityLabel`, and `changes[]`.
4. List endpoints accept bounded `limit`/`offset` (default 100, cap 200) — NFR‑006.
5. Register the module in `app.module.ts`. Add a unit spec (fake tenancy) + an e2e (real login → bearer).
6. New tables: edit `schema.prisma`, add a migration, and add the RLS policy + `cnap_app` grants in a raw-SQL migration (Prisma does not model policies) following the `NULLIF(...)` pattern.

## 7. Conventions

- **Imports:** `from '../generated/prisma'` (never `@prisma/client`).
- **IDs:** tenant PKs are UUIDv7 (`uuidv7()` default; `uuid` v7 in app code for explicit bootstrap). `roles.id` are stable `role_<key>` strings matching the FE.
- **Migrations:** additive; RLS/grants in raw SQL. `migrate reset` is blocked for automated agents — reseed via superuser `TRUNCATE ... CASCADE` + `pnpm prisma:seed`.
- **Testing:** unit tests fake `TenantPrismaService`; e2e tests hit a running seeded Docker DB. `pnpm test` + `pnpm build` are the green gates for every change.
- **Local DB:** dev URLs use `127.0.0.1:55432` (Docker Desktop IPv6 host-forward is unreliable).

## 8. Cross-cutting quality attributes

- **Security (partial — RIO‑NFR‑001):** access control (RBAC + RLS + JWT) is enforced; **encryption in transit (TLS) and at rest is NOT yet configured** — expected to be handled at the ingress/proxy and DB-volume layer in deployment. Passwords are argon2id-hashed.
- **Traceability (RIO‑NFR‑004/015):** every mutation is audited with source→actor→time and is queryable by `entityType`/`entityId`/`actorId`. A requirement→output traceability matrix (NFR‑015) is a separate documentation deliverable, not yet produced.
- **Scalability (RIO‑NFR‑006):** stateless auth (no session store), bounded list pagination, indexed FK/lookup columns, and row-per-entity multitenancy let new entities/villages be added without schema change. No load testing or caching yet.
- **Maintainability (RIO‑NFR‑013):** small single-responsibility modules, strict typing, and a real-DB e2e suite give regression safety; this document is the architecture reference.

## 9. Not yet built

OTP staff-login and forgot/reset-password (need a mail/SMS provider); the PRD assessment pipeline (studies → define-need (AI) → survey → collection → scoring → reports); `citizenChannel`/`dataImport` features (permissions seeded but inert). TLS/at-rest encryption (deployment concern).
