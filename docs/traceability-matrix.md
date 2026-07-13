# Requirements Traceability Matrix (RIO‑NFR‑015)

Links each requirement to its **source** (PRD/spec), **design/plan**, **implementation** (code), and **verification** (tests), with current status. This satisfies RIO‑NFR‑015 ("link each requirement/output to its source; traceability matrix maintained").

**How to maintain:** when a requirement's code or tests change, update its row. Every row's *Verified by* must point at a real spec that runs in `pnpm test`. Runtime, per-record traceability (who changed what, when) is provided separately by the audit trail — see `GET /api/audit?entityType=&entityId=&actorId=`.

**Last updated:** 2026‑07‑13 · **Suite at update:** 75 tests / 22 files green (run over TLS to the db) · **Branch:** `feat/rio-domain-rbac`.

## Legend
- ✅ **Done** — implemented and verified by tests.
- 🟡 **Partial** — core done; a named part is deferred.
- ⛔ **Not built** — planned, not yet implemented.
- ⬜ **N/A (backend)** — belongs to another component (frontend).

## Sources & design artifacts (referenced below by short key)
| Key | Document |
|-----|----------|
| PRD | `docs/PRD.md` |
| CONTRACT | `docs/superpowers/specs/2026-07-12-frontend-api-contract-and-deviations.md` |
| SPINE | `_bmad-output/.../architecture/.../ARCHITECTURE-SPINE.md` |
| DES‑RBAC | `docs/superpowers/specs/2026-07-12-backend-rbac-shell-design.md` |
| DES‑AOUA | `docs/superpowers/specs/2026-07-13-cnap-auth-org-user-audit-design.md` |
| PLAN‑R1R2 | `docs/superpowers/plans/2026-07-12-cnap-r1r2-schema-and-rbac.md` |
| PLAN‑AOUA | `docs/superpowers/plans/2026-07-13-cnap-auth-org-user-audit.md` |
| ARCH | `ARCHITECTURE.md` |

## Matrix

| ID | Requirement | Source · Design | Implementation (code) | Verified by (tests) | Status |
|----|-------------|-----------------|-----------------------|---------------------|--------|
| **RIO‑RBAC‑001** (TEA‑1) | Roles & Permissions; unauthorized blocked; cross‑entity prevented | CONTRACT §2 · DES‑RBAC · PLAN‑R1R2 | `src/rbac/role-matrix.ts`; `src/common/guards/permission.guard.ts`; `src/modules/roles/*`; `prisma/seed.ts` (roles/role_permissions); migration `init_domain` | `src/rbac/role-matrix.spec.ts`; `src/common/guards/permission.guard.spec.ts`; `test/roles.e2e.spec.ts` | ✅ Done |
| **RIO‑FR‑010** | Multi‑Entity Foundation; isolated data; no cross‑entity access | PRD FR‑010 · SPINE · PLAN‑R1R2 | `prisma/migrations/…_rls_domain/migration.sql` (FORCE RLS, NULLIF fail‑closed); `src/tenancy/tenant-prisma.service.ts`; `src/prisma/{prisma,supervisor-prisma}.service.ts` | `src/tenancy/tenant-prisma.service.spec.ts`; cross‑org 403 in `test/users.e2e.spec.ts` & `test/organizations.e2e.spec.ts`; fail‑closed asserted (`SELECT count(*) FROM users`→0) | ✅ Done |
| **RIO‑FR‑007** | Immutable audit log of key events with actor/time | PRD FR‑007 · DES‑AOUA §4.4/§5 · PLAN‑AOUA slice B | `src/modules/audit/audit.service.ts` (`record`); `src/modules/audit/audit.controller.ts`; `AuditLog` model; `rls_domain` (append‑only grants: cnap_app SELECT+INSERT only) | `src/modules/audit/audit.service.spec.ts`; `test/audit.e2e.spec.ts`; immutability asserted (cnap_app `UPDATE audit_logs`→denied) | ✅ Done¹ |
| **RIO‑FR‑Add‑03** | Audit extension: date/time + before/after values | PRD · DES‑AOUA §B2 | `audit_logs.created_at`; `record()` writes `metadata.changes[{field,before,after}]`; diffs in `organizations.service.ts` / `users.service.ts` | `audit.service.spec.ts` (metadata.changes); `organizations.service.spec.ts` & `users.service.spec.ts` (change computation) | ✅ Done |
| **RIO‑NFR‑003** | Access Control: roles + entity separation + consent | PRD · CONTRACT · DES‑AOUA | `permission.guard.ts`; `jwt-auth.guard.ts`; RLS (`rls_domain`); consent → `auth.service.ts` `consent()` writes `consent_acceptances` snapshot | `permission.guard.spec.ts`; `jwt-auth.guard.spec.ts`; `auth.service.spec.ts` (consent snapshot); `test/auth.e2e.spec.ts` (consent); RLS boundary e2e | ✅ Done |
| **RIO‑NFR‑004** | Auditability: decision traceability (source, actor, time) | PRD · DES‑AOUA | `audit.service.ts` (actor/ip/ua/time + before/after); `list()` filters `entityType`/`entityId`/`actorId` | `test/audit.e2e.spec.ts` ("trace a specific entity" filter test) | 🟡 Partial² |
| **RIO‑NFR‑006** | Scalability: add entities/villages without rebuild | PRD · ARCH §8 | Bounded pagination (`users.service.ts` `page()`, `organizations.listAll`, `audit.list` limit/offset); stateless JWT; FK indexes (`init_domain`); row‑per‑entity multitenancy; `villages TEXT[]` | `test/users.e2e.spec.ts` & `test/audit.e2e.spec.ts` (limit bounds); `test/organizations.e2e.spec.ts` (createWithAdmin adds an entity) | 🟡 Partial³ |
| **RIO‑NFR‑013** | Maintainability: documented, extensible, low‑impact change | PRD · ARCH | Per‑feature modules under `src/modules/*`; strict TS (`noUncheckedIndexedAccess`); `ARCHITECTURE.md`; single‑source RBAC | Full regression suite (73 tests) — proves components change without unintended impact | ✅ Done |
| **RIO‑NFR‑015** | Traceability: link requirement/output to source; matrix maintained | PRD | **This document** (`docs/traceability-matrix.md`) + runtime audit filters (NFR‑004) | This matrix is reviewed against `pnpm test` at each update | ✅ Done |
| **RIO‑NFR‑001** | Security (Encryption) in transit **and** at rest; authorized access only | PRD · ARCH §8 | **In transit:** app HTTPS `src/config/https-options.ts` + `main.ts` (+HSTS); app→DB TLS 1.3 `src/prisma/pg-ssl.ts` + `db/Dockerfile` (`ssl=on`). **At rest:** `pgcrypto` (`…_at_rest_pgcrypto` migration) + encrypted storage volume (deployment). Access: guard+RLS+JWT; argon2id creds | `src/config/https-options.spec.ts`; HTTPS proven via `curl` (200 over TLS); DB TLS proven via `pg_stat_ssl` (ssl=t, TLSv1.3) + full suite run with `DB_SSL=true` | ✅ Done⁴ |
| **RIO‑NFR‑009** | Browser Compatibility across modern browsers | PRD | Frontend repo `Project-RIO-Frontend` — no backend surface | — | ⬜ N/A (frontend) |

**Notes**
1. **FR‑007** — `create`/`edit`/`login`/`logout` events are emitted today (org/user mutations, auth). `approve`/`share` are in the `AuditAction` type but have no source features yet (AI‑review approve, sharing = R7); they will emit once those features exist.
2. **NFR‑004** — the traceability *mechanism* (source→actor→time→before/after, queryable per entity) is complete; there are no "published decisions" to trace until the AI‑decision/approval entities (R7) are built.
3. **NFR‑006** — the architecture and pagination are in place (adding an entity/village needs no schema change); load/soak testing and caching are not yet done.
4. **NFR‑001** — **encryption in transit is implemented and verified** on both hops: the API serves HTTPS when a cert/key are configured (else HTTP behind a TLS‑terminating proxy) with HSTS, and the app connects to Postgres over **TLS 1.3** (`DB_SSL=true`, default on with the compose db). **At rest:** `pgcrypto` is enabled for column‑level encryption; bulk at‑rest protection is delegated to encrypted storage volumes at the deployment layer (documented in `ARCHITECTURE.md §8`), which is the standard boundary — no application code encrypts the data files.

## Supporting deliverables (endpoints the requirements ride on)
| Deliverable | Endpoints | Implementation | Tests |
|-------------|-----------|----------------|-------|
| R3 Auth | `POST /api/auth/login\|logout\|consent`, `GET /api/auth/me` | `src/modules/auth/*`; `src/auth/*` | `auth.service.spec.ts`; `test/auth.e2e.spec.ts` |
| R4 Organizations | `GET/PATCH /api/organizations/current`, `GET /api/organizations[/:id]`, `POST /api/organizations` | `src/modules/organizations/*` | `organizations.service.spec.ts`; `test/organizations.e2e.spec.ts` |
| R5 Users | `GET/POST /api/users`, `PATCH /api/users/:id` | `src/modules/users/*` | `users.service.spec.ts`; `test/users.e2e.spec.ts` |
| R6 Audit read | `GET /api/audit` | `src/modules/audit/audit.controller.ts` | `test/audit.e2e.spec.ts` |

## Coverage summary
| Status | Count | Requirements |
|--------|-------|--------------|
| ✅ Done | 8 | RBAC‑001, FR‑010, FR‑007, FR‑Add‑03, NFR‑003, NFR‑013, NFR‑015, **NFR‑001** |
| 🟡 Partial | 2 | NFR‑004 (decisions = R7), NFR‑006 (no load test) |
| ⬜ N/A backend | 1 | NFR‑009 (frontend) |

## Open items (to reach full coverage)
- **NFR‑004 / FR‑007:** emit `approve`/`share` audit events when the R7 AI‑review & sharing features land; add the AI‑decision entity for "published decisions."
- **NFR‑006:** add load/soak testing and a caching strategy as data volume grows.
- **Deployment (NFR‑001 hardening, not a code gap):** supply CA‑signed certs (replace the self‑signed dev cert), terminate TLS at the ingress if not in‑app, and enable encrypted storage volumes for bulk at‑rest.
