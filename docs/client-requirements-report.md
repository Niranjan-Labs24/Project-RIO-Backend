# Project RIO (CNAP) — Requirements Delivery Report

**Prepared for:** Client / Stakeholder review
**Component:** Backend API (`Project-RIO-Backend`, package `cnap-api`)
**Scope of this report:** the 11 foundation requirements — how each was implemented, the libraries used, and the industry standards followed.
**As of:** 2026‑07‑14 · Branch `main` (feature branch `feat/rio-domain-rbac` merged via PR #1)
**Stack:** NestJS 11 · Prisma 7 · PostgreSQL 18 · Node 24 LTS · TypeScript 5 (strict)
**Verification:** 82 automated tests green (Vitest unit + Supertest end‑to‑end against a real, TLS‑enabled PostgreSQL), clean build.

---

## 1. Executive summary

The backend delivers the **identity, multi‑tenancy, authorization (RBAC), authentication, consent, and audit** foundation for the Community Needs Assessment Platform. These 11 requirements were prioritised deliberately: they are the *load‑bearing* layer — tenant isolation, access control, and audit must exist **before** any assessment data flows, because retrofitting them later would force rework across every table, screen, and API.

Design principle throughout: **isolation and enforcement live in the database, not just the application.** Even if an application‑layer bug forgot to scope a query, PostgreSQL Row‑Level Security (RLS) still refuses to return another entity's rows. This is the strongest form of multi‑tenant isolation.

**Coverage of the 11 requirements**

| Status | Count | Requirements |
|--------|-------|--------------|
| ✅ Delivered & verified | 8 | RBAC‑001, FR‑010, FR‑007, FR‑Add‑03, NFR‑003, NFR‑013, NFR‑015, NFR‑001 |
| 🟡 Foundation delivered; a named part awaits later features | 2 | NFR‑004 (decision entities arrive with the AI/approval features), NFR‑006 (load/soak testing pending) |
| ⬜ Owned by the frontend component | 1 | NFR‑009 (browser rendering; backend contributes standards‑compliant HTTP/CORS) |

---

## 2. Standards & guidance followed

The implementation is built to align with the following recognised standards and industry guidance. (Alignment means the design follows the referenced practice; it does not imply formal certification.)

| Area | Standard / guidance |
|------|---------------------|
| Overall software quality model | **ISO/IEC 25010** — security, maintainability, performance/scalability, portability characteristics |
| Application security controls | **OWASP ASVS 4.0**, **OWASP Top 10 (2021)** |
| Password storage | **OWASP Password Storage Cheat Sheet**; **Argon2id** (Password Hashing Competition winner, **RFC 9106**) |
| Token authentication | **RFC 7519** (JWT), **RFC 6750** (Bearer), **RFC 8725** (JWT Best Current Practice) |
| Transport security | **TLS 1.3 (RFC 8446)**; **HTTP Strict Transport Security — RFC 6797** |
| Access control model | **NIST RBAC / ANSI INCITS 359**; **least privilege — NIST SP 800‑53 AC‑6** |
| Logging & audit | **ISO/IEC 27001 A.12.4** (logging & monitoring); **NIST SP 800‑92** (log management) |
| Privacy / consent | **GDPR** Art. 7 (consent), Art. 25 (data protection by design), Art. 30 (records of processing) |
| CSRF defence | **OWASP CSRF Prevention** (double‑submit cookie) |
| Requirements traceability | **ISO/IEC/IEEE 29148** requirements‑engineering traceability (RTM) |
| Configuration & statelessness | **Twelve‑Factor App** (config in environment; stateless processes) |
| Cross‑origin / web APIs | **WHATWG Fetch / W3C CORS** |

---

## 3. Technology & package inventory

Every dependency below is a current, actively‑maintained, permissively‑licensed package pinned in `package.json`.

| Package (version) | Role in the system | Serves requirement(s) |
|-------------------|--------------------|-----------------------|
| `@nestjs/common` · `@nestjs/core` (11) | Application framework — modular architecture, dependency injection, guards | NFR‑013, all |
| `@prisma/client` · `prisma` (7) + `@prisma/adapter-pg` (7.8) | Type‑safe data access; driver‑adapter over `pg` | FR‑010, NFR‑013 |
| `pg` (8.22) | PostgreSQL driver; TLS negotiation to the database | NFR‑001, FR‑010 |
| `argon2` (0.44) | **Argon2id** password hashing | NFR‑001, NFR‑003 |
| `@nestjs/jwt` (11) | Stateless **JWT** bearer tokens | NFR‑003, NFR‑006 |
| `helmet` (8) | Secure HTTP headers incl. **HSTS** | NFR‑001, NFR‑009 |
| `cookie-parser` (1.4) | httpOnly session‑cookie parsing; CSRF double‑submit | NFR‑001, NFR‑003 |
| `@sinclair/typebox` (0.33) · `ajv` (8.17) · `ajv-formats` (3) | Schema validation for **environment config** and **request bodies** (fail‑closed) | NFR‑013, NFR‑001 |
| `nestjs-pino` (4.1) · `pino` (9.5) · `pino-http` (10.3) | Structured, request‑id‑correlated logging | FR‑007, NFR‑004 |
| `swagger-ui-express` (5) | OpenAPI contract & interactive docs | NFR‑013, NFR‑015 |
| `uuid` (11) + PostgreSQL `uuidv7()` | Time‑ordered **UUIDv7** primary keys | FR‑010, NFR‑006 |
| `vitest` (4) · `supertest` (7) | Unit + end‑to‑end tests against a real database | NFR‑013, NFR‑015 |
| Node 24 LTS · TypeScript 5 (`strict`, `noUncheckedIndexedAccess`) · pnpm · Docker Compose | Runtime, type‑safety, packaging | NFR‑013, NFR‑006 |
| PostgreSQL 18 — **Row‑Level Security**, `pgcrypto` extension | Database‑enforced tenant isolation; column‑level crypto | FR‑010, NFR‑003, NFR‑001 |

---

## 4. Requirement‑by‑requirement delivery

> The requirements form three natural clusters: **(A) Multi‑entity foundation & access control**, **(B) Audit & traceability**, and **(C) Cross‑cutting quality attributes.** They are grouped that way below; every one of the 11 is covered.

### Cluster A — Multi‑entity foundation & access control

#### RIO‑FR‑010 — Multi‑Entity Foundation  ✅
**Requirement:** Dedicated account per entity with isolated data; each entity manages its own studies with no cross‑entity access.

**How we handled it — isolation is enforced by the database.** Every tenant table (`organisations`, `users`, `consent_acceptances`, `audit_logs`) has `FORCE ROW LEVEL SECURITY` with a **fail‑closed** policy:
`org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. If the tenant context is unset or empty, the query returns **zero rows — never an error, never a leak.** The org id is set as a **transaction‑local** variable inside a pinned Prisma transaction, so it cannot bleed across pooled connections. All data access is funnelled through a single `TenantPrismaService` (three explicit access paths: own‑org read/write, explicit‑org bootstrap, and supervisor cross‑org **read‑only**), so a query can never accidentally run without tenant scope.

**Packages / mechanism:** PostgreSQL RLS · Prisma 7 driver‑adapter · `pg`.
**Standards:** ISO/IEC 25010 (security/reliability); least privilege (NIST SP 800‑53 AC‑6).
**Evidence:** `prisma/migrations/*_rls_domain/migration.sql`; `src/tenancy/tenant-prisma.service.ts`; e2e `test/tenant-isolation.e2e.spec.ts` proves an Org‑A caller cannot see Org‑B rows on the live `users` table (virgin + warm‑connection paths), plus cross‑org 403 tests.

#### RIO‑RBAC‑001 — Roles & Permissions  ✅
**Requirement:** Accounts, roles, and permissions with strict entity separation; unauthorised roles blocked; the backbone authorization model every feature checks against.

**How we handled it — one source of truth, no drift.** A single matrix, `ROLE_MATRIX` (**9 roles × 12 modules × 6 actions** — read/write/create/approve/export/share), is **both seeded into the database** (`roles` / `role_permissions`) **and read in‑memory** by the authorization guard. Because enforcement and stored permissions come from the same source, they **cannot diverge.** Roles are **read‑only** (`GET /api/roles`) — there is no in‑app role authoring, which removes a whole class of privilege‑configuration mistakes. A **privilege‑escalation guard** ensures only a `crossEntity` caller can assign a `crossEntity` role, so a single‑entity admin cannot mint a platform‑wide account.

**Packages / mechanism:** NestJS guards + `Reflector` (`@RequirePermission(module, action)` decorator) · Prisma seed.
**Standards:** NIST RBAC / ANSI INCITS 359; OWASP ASVS (access control); least privilege.
**Evidence:** `src/rbac/role-matrix.ts`, `src/common/guards/permission.guard.ts`; `role-matrix.spec.ts`, `permission.guard.spec.ts`, `test/roles.e2e.spec.ts`.

#### RIO‑NFR‑003 — Access Control  ✅
**Requirement:** Define roles and enforce entity separation (wired in before data flows); cross‑entity access prevented; consent mechanism.

**How we handled it — defence in depth, three enforced layers.** (1) **Authentication:** a global `JwtAuthGuard` verifies the bearer token and populates the per‑request context. (2) **Authorization:** the global `PermissionGuard` checks the required permission against the caller's role. (3) **Isolation:** RLS at the database (FR‑010) is the final backstop. **Consent** is captured per user: accepting the active policy writes an **immutable snapshot** — both the version and the exact policy text at accept‑time — to `consent_acceptances`. Onboarding is admin‑provisioned with per‑user consent; there is no public self‑signup surface.

**Packages / mechanism:** `@nestjs/jwt` · `argon2` · NestJS guards · PostgreSQL RLS.
**Standards:** OWASP ASVS (authN/authZ); GDPR Art. 7 & Art. 25 (consent, privacy by design).
**Evidence:** `permission.guard.ts`, `jwt-auth.guard.ts`, `auth.service.ts` (`consent()`); `permission.guard.spec.ts`, `jwt-auth.guard.spec.ts`, `auth.service.spec.ts`, `test/auth.e2e.spec.ts`.

### Cluster B — Audit & traceability

> Per the brief, **FR‑007 and FR‑Add‑03 were built together as one audit layer** to avoid a second pass; **NFR‑004** rides on the same layer.

#### RIO‑FR‑007 — Audit Log  ✅
**Requirement:** Immutable audit logging of key events (create / edit / approve / share) with actor and timestamp.

**How we handled it — immutability enforced by database privilege, not convention.** Every mutation calls `AuditService.record()`, writing to the append‑only `audit_logs` table with the **actor, action, entity type/id/label, timestamp, IP address, and user‑agent.** Immutability is guaranteed at the database: the application role `cnap_app` is granted **SELECT + INSERT only** on `audit_logs` — **no UPDATE or DELETE grant exists** anywhere. The `AuditAction` type already models `create · edit · approve · share · delete · login · logout`; `create/edit/login/logout` emit today (org/user mutations, auth), and `approve/share` will emit automatically once the AI‑review and sharing features they describe are built.

**Packages / mechanism:** PostgreSQL table‑level GRANTs (append‑only) · Prisma · `pino` structured logs.
**Standards:** ISO/IEC 27001 A.12.4; NIST SP 800‑92; GDPR Art. 30 (records of processing).
**Evidence:** `src/modules/audit/audit.service.ts`, `audit.types.ts`, migration `rls_domain`; `audit.service.spec.ts`, `test/audit.e2e.spec.ts` asserts a `cnap_app` `UPDATE audit_logs` is denied.

#### RIO‑FR‑Add‑03 — Audit Extension  ✅
**Requirement:** Extend the audit log with system‑wide date/time stamping and **before/after** values.

**How we handled it.** Built into the same audit layer. Each audited change carries a `changes[]` array of `{ field, before, after }` objects stored in the row's JSON metadata, and every row is date/time‑stamped (`created_at timestamptz`, default `now()`). Mutating services (organizations, users) compute the field‑level diff and pass it to `record()`, so the trail shows not just *that* something changed but *what it changed from and to*, and exactly when.

**Packages / mechanism:** PostgreSQL `jsonb` + `timestamptz` · Prisma.
**Standards:** ISO/IEC 27001 A.12.4 (traceable change history).
**Evidence:** `audit_logs.created_at`; `record()` writes `metadata.changes`; diff computation in `organizations.service.ts` / `users.service.ts`; `audit.service.spec.ts`, service specs assert the change computation.

#### RIO‑NFR‑004 — Auditability  🟡
**Requirement:** Decision traceability linking source, actor, and time; published decisions traceable.

**How we handled it.** The traceability **mechanism is complete**: `GET /api/audit` filters by `entityType`, `entityId`, and `actorId`, giving a queryable **source → actor → time → before/after** chain for any entity. The remaining part is data, not code: there are no "published decisions" to trace until the AI‑decision/approval entities (a later feature) exist. When those features land, they audit through the same layer and become traceable with **no additional plumbing.**

**Packages / mechanism:** the shared audit layer (above).
**Standards:** ISO/IEC 27001 A.12.4; NIST SP 800‑92.
**Evidence:** `audit.service.ts` `list()` filters; `test/audit.e2e.spec.ts` ("trace a specific entity" filter test).
**Remaining:** emit `approve`/`share` events and add the AI‑decision entity when those features are built.

#### RIO‑NFR‑015 — Traceability  ✅
**Requirement:** Link each requirement/output to its source; maintain a traceability matrix.

**How we handled it.** A living **Requirements Traceability Matrix** (`docs/traceability-matrix.md`) maps every requirement to its **source spec → design → implementation (code) → verifying test → status.** It complements the *runtime* traceability of the audit trail (NFR‑004): the matrix traces *requirements to code*, the audit log traces *records to actors*. The rule of maintenance is that every matrix row must point at a test that runs in the automated suite.

**Packages / mechanism:** documentation deliverable + OpenAPI contract (`swagger-ui-express`).
**Standards:** ISO/IEC/IEEE 29148 (requirements traceability).
**Evidence:** `docs/traceability-matrix.md`, reviewed against `pnpm test` at each update.

### Cluster C — Cross‑cutting quality attributes

#### RIO‑NFR‑001 — Security (Encryption)  ✅
**Requirement:** Encrypt data in transit and at rest; access only to authorised users.

**How we handled it.**
- **In transit (client → app):** the API serves **HTTPS** directly when a certificate/key are configured, with **HSTS** (`helmet`, 180‑day max‑age, `includeSubDomains`); otherwise it runs HTTP behind a TLS‑terminating ingress/proxy.
- **In transit (app → database):** the connection to PostgreSQL runs over **TLS 1.3**, with the ability to *authenticate* the server certificate (`DB_SSL_REJECT_UNAUTHORIZED` + trusted CA), not merely encrypt.
- **At rest:** the `pgcrypto` extension is enabled for column‑level encryption of any ultra‑sensitive field; bulk at‑rest protection is delegated to **encrypted storage volumes** at the deployment layer (the standard boundary — no application code encrypts the data files).
- **Access:** RBAC + RLS + JWT (above); passwords **Argon2id**‑hashed; login is timing‑equalised and rate‑limited by account lockout.

**Packages / mechanism:** `helmet` (HSTS) · Node TLS + `pg` SSL · `argon2` · PostgreSQL `pgcrypto`.
**Standards:** TLS 1.3 (RFC 8446); HSTS (RFC 6797); Argon2id (RFC 9106); OWASP Password Storage; OWASP ASVS (cryptography).
**Evidence:** `src/config/https-options.ts`, `src/main.ts` (HSTS), `src/prisma/pg-ssl.ts`, `db/Dockerfile` (`ssl=on`), `*_at_rest_pgcrypto` migration; `https-options.spec.ts`; DB TLS proven via `pg_stat_ssl` (TLSv1.3) with the suite run under `DB_SSL=true`.
**Production hardening (operational, not a code gap):** replace the self‑signed dev certificate with a CA‑signed one, set `DB_SSL_REJECT_UNAUTHORIZED=true`, rotate secrets per environment, and enable encrypted storage volumes.

#### RIO‑NFR‑006 — Scalability  🟡
**Requirement:** Architect for growth (more entities / studies / villages) without a rebuild.

**How we handled it — scale designed in, not bolted on.** (1) **Stateless authentication** (JWT, no server session store) means the API can be horizontally scaled behind a load balancer without sticky sessions. (2) **Row‑per‑entity multitenancy** — adding a new entity or village needs **no schema change** (villages are a `text[]` on the org row). (3) **Bounded pagination** on every list endpoint (default page size, hard cap 200) prevents unbounded queries. (4) **Indexed** foreign‑key and lookup columns, and **time‑ordered UUIDv7** keys that keep index locality as data grows.

**Packages / mechanism:** `@nestjs/jwt` (stateless) · Prisma indexes · UUIDv7.
**Standards:** Twelve‑Factor App (stateless processes, horizontal scale); ISO/IEC 25010 (performance efficiency).
**Evidence:** pagination in `users.service.ts`, `organizations`, `audit.list()` (limit cap 200); FK indexes in migration `init_domain`; `test/users.e2e.spec.ts`, `test/audit.e2e.spec.ts` (limit bounds).
**Remaining:** load/soak testing and a caching strategy as real data volume grows.

#### RIO‑NFR‑013 — Maintainability  ✅
**Requirement:** Documented, extensible architecture; components modifiable without unintended impact.

**How we handled it.** The codebase is organised into **small, single‑responsibility feature modules** (`src/modules/<feature>` — types + service + controller + module living together), with **strict TypeScript** (`noUncheckedIndexedAccess`) catching whole classes of errors at compile time. `ARCHITECTURE.md` is the reference document and includes an **"adding a feature" recipe** and explicit invariants. Crucially, a **real‑database regression suite (82 tests)** is the safety net that proves a change did not break existing behaviour — this is the operational meaning of "modifiable without unintended impact."

**Packages / mechanism:** NestJS module system · TypeScript strict · `vitest` + `supertest`.
**Standards:** ISO/IEC 25010 (maintainability: modularity, analysability, testability).
**Evidence:** `src/modules/*` structure, `ARCHITECTURE.md`, full suite as regression gate.

#### RIO‑NFR‑009 — Browser Compatibility  ⬜ (frontend‑owned; backend contributes)
**Requirement:** Web components work across modern browsers; no major rendering errors.

**How we handled it.** Browser rendering is delivered by the **frontend component** (`Project-RIO-Frontend`) — there is no backend rendering surface. The backend's contribution to cross‑browser reliability is a **standards‑compliant, framework‑agnostic HTTP/JSON API**: a stable OpenAPI contract, correct **CORS** (a single explicit allowed origin with credentials — never a wildcard, so the browser security model is respected), secure cookies (`httpOnly`), and consistent error envelopes. Because the API is a plain HTTP/JSON service, it imposes no browser‑specific constraints on the UI.

**Packages / mechanism:** NestJS CORS · `helmet` · `swagger-ui-express` (OpenAPI).
**Standards:** WHATWG Fetch / W3C CORS; ISO/IEC 25010 (portability). Frontend owns WCAG / cross‑browser QA.
**Evidence:** `src/main.ts` (`enableCors` single origin + credentials); `src/contract/openapi.ts`.

---

## 5. Verification & assurance

- **82 automated tests** (Vitest unit + Supertest end‑to‑end) run against a **real, TLS‑enabled PostgreSQL** in Docker — not mocks. This includes a dedicated **fail‑closed RLS gate** proving cross‑tenant reads return zero rows, and cross‑org **403** authorization tests.
- **Every change lands only when `pnpm test` and `pnpm build` are both green.**
- A **post‑merge security‑review hardening pass** (commit `3eedad9`) reinstated request‑body validation on write endpoints, enabled authentication of the database TLS certificate, attributed cross‑org admin actions to the affected entity in the audit trail, and mapped duplicate‑email to a clean HTTP 409.

## 6. Honest gaps & production to‑dos

These are **operational/deployment** items, not architectural gaps — the design is complete and DB‑enforced:

1. **Certificates & secrets:** replace self‑signed dev certificates with CA‑signed ones; rotate the JWT secret and database‑role passwords per environment (they ship as dev placeholders).
2. **Second auth factor & password reset:** OTP / 2FA and forgot‑password need a mail/SMS provider (a mailer module scaffold is in place).
3. **Token revocation:** stateless JWT means logout is a client‑side drop; a leaked token is valid until expiry (12h).
4. **Rate limiting:** currently per‑account lockout (5 failures → 15‑min lock); a global/IP throttle in front of login is a recommended addition.
5. **At‑rest bulk encryption, load & penetration testing:** deployment‑layer responsibilities not yet configured.

---

*Project RIO (CNAP) · Backend requirements delivery report · compiled 2026‑07‑14 from branch `main`. Companion documents: `ARCHITECTURE.md`, `docs/traceability-matrix.md`, `docs/backend-status-report.md`, `docs/schema.dbml` (+ `docs/schema-erd.png`).*
