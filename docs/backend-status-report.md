# CNAP API — Backend Features & Security Report

A multi-tenant, RBAC-guarded NestJS backend for the **Community Needs Assessment Platform (Project Rio)**. Tenant isolation is enforced in the database, not the application. This report covers what is built, how it works, its security posture, and the full data schema.

| | |
|---|---|
| **Repo** | `Project-RIO-Backend` (package name `cnap-api`) |
| **Branch** | `main` (feature branch `feat/rio-domain-rbac` merged via PR #1, `99b7335`) |
| **As of** | 2026-07-13 |
| **Stack** | NestJS 11 · Prisma 7 · PostgreSQL 18 |
| **Verification** | 82 tests green / 23 files (Vitest unit + supertest e2e against a real Docker DB) |

> Compiled from the committed state of `main`: `prisma/schema.prisma` + migrations, `src/rbac/role-matrix.ts`, the security/tenancy/auth modules, `ARCHITECTURE.md`, and `docs/traceability-matrix.md`. All work described here is merged and committed — the identity/RBAC/org/user/audit foundation plus a post-merge **security-review hardening pass** (commit `3eedad9`) covering input validation, DB-cert verification, audit attribution, and a fail-closed RLS CI gate. Note: the `traceability-matrix.md` header still reads "75 tests / feat branch"; the authoritative current count on `main` is **82**.

**Status key:** ✅ Done · 🟡 Partial · ⛔ Not built · ⬜ Frontend / N-A

---

## 1. Security posture at a glance

| Area | State | Notes |
|------|-------|-------|
| **Tenant isolation** | DB Row-Level Security | FORCE RLS, fail-closed. Empty context returns zero rows, never an error. |
| **Authorization** | RBAC · 9 × 12 × 6 | Single source of truth, seeded to DB *and* enforced in-memory — cannot drift. |
| **Authentication** | argon2id + JWT bearer | 5-fail lockout, timing-safe login. OTP / password-reset pending. |
| **Encryption in transit** | TLS on both hops | App HTTPS + HSTS; app→DB over TLS 1.3. Self-signed dev cert — needs CA cert in prod. |
| **Audit trail** | Append-only | Actor · IP · UA · time + before/after diffs. No UPDATE/DELETE grant. |
| **Verification** | 82 tests · real DB | Vitest unit + supertest e2e against a seeded Postgres, incl. a fail-closed RLS gate. Build clean. |

The backend implements the identity, tenancy, RBAC, auth, and audit layer. The domain assessment pipeline (studies → scoring → reports) is scoped but not yet built.

---

## 2. Features implemented

Six feature areas ship as independent NestJS modules. Every route is annotated with a required permission `@RequirePermission(module, action)`; cross-organisation reads additionally require a role flagged `crossEntity`.

### Feature modules

| Module | Capability | Status |
|--------|-----------|--------|
| `roles` | Read-only 9-role permission matrix (no in-app role authoring) | ✅ |
| `auth` | Login, session (`me`), logout, per-user consent capture | 🟡 |
| `organizations` | Own-org read/update; System-Admin list-all, get-by-id, create-org-with-first-admin | ✅ |
| `users` | List, invite (status `invited`), update; System-Admin cross-org list/invite | ✅ |
| `audit` | Query immutable audit trail; own-org or cross-org; entity/actor filters | ✅ |
| `health` | Liveness probe | ✅ |
| assessment pipeline | Studies → define-need (AI) → survey → collection → scoring → reports → sharing | ⛔ |
| `dataImport` · `citizenChannel` | Permissions seeded but features deliberately inert this phase | ⛔ |

### Endpoint inventory

Global prefix `/api`, default port `4000`. Response body is the raw payload (no wrapper); errors use a consistent `{ error{code,message}, message, code }` envelope.

| Method | Path | Purpose | Permission gate |
|--------|------|---------|-----------------|
| GET | `/api/roles` | Full role × permission matrix | `rolesPermissions:read` |
| POST | `/api/auth/login` | Exchange credentials for a session + JWT (200) | open |
| GET | `/api/auth/me` | Current session context (re-issues token) | authenticated |
| POST | `/api/auth/logout` | Record logout event (204; stateless) | authenticated |
| POST | `/api/auth/consent` | Accept active consent policy + snapshot it | authenticated |
| GET | `/api/organizations/current` | Caller's own organisation | `entityTeam:read` |
| PATCH | `/api/organizations/current` | Update own organisation (diff audited) | `entityTeam:write` |
| GET | `/api/organizations` | All orgs + member counts | `entityTeam:read` + crossEntity |
| GET | `/api/organizations/:id` | One org by id | `entityTeam:read` + crossEntity |
| POST | `/api/organizations` | Create org + first NGO Admin together | `entityTeam:create` + crossEntity |
| GET | `/api/users` | Own-org users; `?organizationId` → cross-org | `entityTeam:read` |
| POST | `/api/users` | Invite a user (status invited) | `entityTeam:create` |
| PATCH | `/api/users/:id` | Update name / role / status (diff audited) | `entityTeam:write` |
| GET | `/api/audit` | Audit events; filters + pagination | `archiveSharingAudit:read` |

---

## 3. How it is implemented

### Technology

| Concern | Choice |
|---------|--------|
| Runtime | NestJS 11 · Node 24 LTS · TypeScript 5 strict (`noUncheckedIndexedAccess`) |
| Data access | Prisma 7 driver-adapter (`@prisma/adapter-pg`); client generated to `src/generated/prisma` |
| Database | PostgreSQL 18 with Row-Level Security + 3 login roles |
| Identity | argon2id hashing · stateless JWT bearer (`@nestjs/jwt`) |
| Validation | TypeBox + AJV for both environment config and request bodies |
| HTTP hardening | `helmet` (HSTS) · `cookie-parser` · global exception filter |
| Logging | `nestjs-pino` — structured, request-id correlated |
| Testing | Vitest 4 (unit, faked tenancy) + supertest e2e against a real Docker DB |
| Packaging | pnpm · Docker Compose (TLS-enabled Postgres image) |

### Request lifecycle

```
HTTP
  → OrgContextMiddleware   builds OrgStore (AsyncLocalStorage): requestId, ip, ua; dev x-org-id/x-role seam
  → JwtAuthGuard  (global) bearer → verified claims overwrite OrgStore; invalid token = 401; absent = non-blocking
  → PermissionGuard (global) @RequirePermission(module, action) vs OrgStore.role in ROLE_MATRIX
  → Controller → Service   typed payloads; AuditService.record() on every mutation
  → TenantPrismaService    sets app.current_org_id GUC inside a pinned transaction
  → Postgres (RLS)         policy filters every row
```

`OrgStore` is an `AsyncLocalStorage` record carrying `{ requestId, orgId?, actorId?, role?, ip?, userAgent? }` for the life of a request; everything downstream reads it instead of threading context through call signatures.

### Tenancy access paths — `TenantPrismaService`

| Method | Use when | DB role |
|--------|----------|---------|
| `runInOrgContext(fn)` | Ambient authenticated read/write scoped to the caller's org | `cnap_app` |
| `runAsOrg(orgId, fn)` | Explicit-org bootstrap: org creation, login counters | `cnap_app` |
| `runAsSupervisor(fn)` | Cross-org **reads** for crossEntity roles; pre-login email lookup | `cnap_supervisor` |

Services never call Prisma directly — all data access flows through these three methods, so an unset org context can only ever return zero rows, never leak across tenants.

---

## 4. Security & how secure we are

Security is layered, defence-in-depth: even if an application bug forgot to scope a query, the database still refuses to return another tenant's rows. Eight pillars carry the posture.

**1. Tenant isolation — enforced by the database**
- Every tenant table has `FORCE ROW LEVEL SECURITY` with a fail-closed policy: `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`.
- An unset/empty org context yields **zero rows** — never an error, never a leak. FORCE applies the policy even to the table owner.
- The org id is a **transaction-local** setting inside a pinned Prisma transaction, so it cannot bleed across pooled connections.

**2. Least privilege — three database roles**
- `cnap_owner` — migrations & seed only (Prisma CLI). The running app **never holds owner credentials**; the env schema deliberately excludes them.
- `cnap_app` — runtime, `NOBYPASSRLS`. DML on tenant tables; **SELECT + INSERT only** on `audit_logs` (append-only); SELECT-only on reference tables.
- `cnap_supervisor` — runtime, `NOBYPASSRLS`, **SELECT-only cross-org**. The only cross-tenant read path; there is **no cross-tenant write path** anywhere.

**3. Authorization — one source of truth, no drift**
- `ROLE_MATRIX` (9 roles × 12 modules × 6 actions) is both **seeded into the database** and **read in-memory** by the guard, so enforcement and stored permissions cannot diverge.
- Roles are **read-only** — no in-app role authoring — removing a whole class of privilege-configuration mistakes.
- **Privilege-escalation guard:** only a `crossEntity` caller may assign a `crossEntity` role, so a tenant admin cannot mint a platform-wide account.

**4. Authentication — hashing, tokens, lockout**
- Passwords hashed with **argon2id**. JWT secret must be ≥ 32 chars (validated at boot); tokens carry `sub · orgId · roleKey` and expire in 12h.
- **5-failure account lockout** for 15 minutes (HTTP 423). Login is **timing-equalised** — a dummy hash verify on the not-found path defeats username enumeration by response time.
- A deactivated organisation is rejected **after** credential verification, so org state is never revealed to an unauthenticated caller.

**5. Consent — versioned & immutable**
- Consent policies are versioned; accepting one writes an **immutable snapshot** to `consent_acceptances` capturing the version **and the exact policy text** at accept-time.
- Onboarding is admin-provisioned + per-user consent — there is no public self-signup surface.

**6. Audit — append-only, before/after**
- Every mutation calls `AuditService.record()` capturing **actor · IP · user-agent · timestamp** plus a `changes[]` array of `{field, before, after}`.
- Immutability is enforced **at the database** — `cnap_app` has no UPDATE/DELETE grant on `audit_logs`. Cross-org queries are read via the supervisor role.

**7. Encryption in transit & at rest**
- **In transit (client→app):** serves HTTPS directly when a cert/key are configured (with **HSTS**), otherwise HTTP behind a TLS-terminating proxy.
- **In transit (app→DB):** connects to Postgres over **TLS 1.3** (`DB_SSL=true`, default-on with the compose db that ships `ssl=on`).
- **At rest:** `pgcrypto` enabled for column-level encryption; bulk at-rest protection is delegated to encrypted storage volumes at the deployment layer.

**8. Fail-safe defaults & hardening**
- Unset `NODE_ENV` defaults to **production** (strictest mode). The dev-only `x-org-id` / `x-role` header seam is gated off outside non-production.
- Environment config is schema-validated and **fails closed** at boot on any missing/invalid value.
- The global exception filter emits a consistent envelope and never leaks stack traces — internal errors return a generic 500.

### Honest assessment

**Strengths**
- **Isolation is structural.** RLS at the DB means an app-layer bug cannot cross tenants — the strongest form of multi-tenant isolation.
- **No cross-tenant write path exists** at all; cross-org access is read-only by role and by DB grant.
- **Append-only audit** is enforced by database privileges, not just convention.
- **Single-source RBAC** with an explicit escalation guard closes the most common authorization gaps.
- **Login hardening** — argon2id, lockout, timing-safe — is above baseline for an MVP.
- **Verified:** 82 tests against a real Postgres assert the fail-closed and cross-org-403 behaviours, not just happy paths — including a dedicated cross-tenant RLS gate (`test/tenant-isolation.e2e.spec.ts`) that proves an Org-A caller cannot see Org-B rows on the live `users` table.
- **Reviewed:** a post-merge code-review pass (`3eedad9`) reinstated TypeBox input validation on write endpoints (bad `limit`/`offset` can't reach Prisma as `NaN`), made the DB connection able to *authenticate* the Postgres cert (`DB_SSL_REJECT_UNAUTHORIZED` + `DB_SSL_CA`), attributed cross-org admin actions to the affected org in the audit trail, and mapped duplicate-email to a clean 409.

**Gaps & production to-dos**
- **Certificates are self-signed (dev).** Replace with CA-signed certs; set `DB_SSL_REJECT_UNAUTHORIZED=true` so the DB is authenticated, not just encrypted.
- **Secrets are placeholders.** The JWT secret and the three DB-role passwords ship as dev defaults — rotate per environment before any real deployment.
- **No OTP / 2FA or password reset** yet (needs a mail/SMS provider).
- **No token revocation.** Stateless JWT means logout is a client-side drop; a leaked token is valid until expiry.
- **Rate limiting is per-account only** (lockout) — no global/IP throttle in front of login.
- **Bulk at-rest encryption** is a deployment responsibility (encrypted volumes) and is not yet configured. No load or penetration testing performed.

> **Bottom line:** the security *architecture* is strong and DB-enforced, and the implemented surface is well-hardened and tested. What stands between it and production-grade is *operational* — real certificates, rotated secrets, a second auth factor, and encrypted storage — not a redesign.

---

## 5. Data schema

Seven tables across three concerns — global **reference** data (seeded, read-only), **tenancy & identity**, and the **audit** trail — plus three enums. Tenant primary keys are UUIDv7 (`uuidv7()`); `roles.id` are stable `role_<key>` strings matching the frontend.

### Enums

| Enum | Values |
|------|--------|
| `Sector` | education · healthcare · agriculture · wash · livelihoods · disaster_relief · other |
| `UserStatus` | active · invited |
| `PermissionModule` | entityTeam · rolesPermissions · onboardingConsent · methodologyQuestionBank · studySurvey · dataCollection · dataImport · citizenChannel · aiReview · priorityScoring · reportsDashboards · archiveSharingAudit |

Key legend: **PK** primary · **FK** foreign · **UQ** unique · **IX** indexed · `?` nullable.

### `roles` — reference · no RLS · app SELECT-only
The nine platform roles. Seeded from `ROLE_MATRIX`; exposed read-only via `GET /api/roles`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | varchar(64) | Stable `role_<key>` id (matches FE) |
| **UQ** key | varchar(64) | Machine key, e.g. `ngo_admin` |
| name | varchar(120) | Display name |
| description | text | Human description |
| cross_entity | boolean | Grants cross-organisation read scope |

### `role_permissions` — reference
One row per (role, module) with six boolean action flags. Unique on `(role_id, module)`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` default |
| **FK UQ** role_id | varchar(64) | → `roles.id` |
| **UQ** module | PermissionModule | One of the 12 modules |
| read / write / create | boolean | Action grants (default false) |
| approve / export / share | boolean | Action grants (default false) |

### `consent_policies` — reference
Versioned, append-only consent policy text. Seeded with `v1`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` |
| **UQ** version | varchar(64) | e.g. `v1` |
| text | text | Full policy copy |
| active | boolean | Currently-effective version (default false) |
| created_at | timestamptz | default now() |

### `organisations` — tenant-root · RLS keyed on `id`
The tenant boundary. RLS restricts each org to its own row (keyed on `id`), which also enables the org-creation bootstrap.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` |
| name | varchar(200) | Organisation name |
| region | varchar(200) `?` | Nullable |
| email | varchar(320) `?` | Nullable contact |
| sector | Sector `?` | Nullable enum |
| logo_url | text `?` | Nullable |
| villages | text[] | Default empty array (scale without schema change) |
| is_active | boolean | Default true; false blocks login |
| created_at / updated_at | timestamptz | Managed timestamps |

### `users` — RLS on `org_id`
Members of an organisation. Email is globally unique. Login state (attempts, lockout, last login) lives here. Indexed on `org_id` and `role_id`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` |
| **FK IX** org_id | uuid | → `organisations.id` (cascade delete) |
| **FK IX** role_id | varchar(64) | → `roles.id` |
| name | varchar(200) | |
| **UQ** email | varchar(320) | Globally unique |
| status | UserStatus | Default `invited` |
| password_hash | varchar(255) `?` | argon2id; null until credential set |
| consented_at | timestamptz `?` | Last consent acceptance |
| failed_login_attempts | int | Default 0; drives lockout |
| locked_until | timestamptz `?` | Lockout expiry |
| last_login_at | timestamptz `?` | |
| created_at / updated_at | timestamptz | |

### `consent_acceptances` — RLS on `org_id`
Immutable record of each consent a user accepted — snapshots the version **and** the exact policy text at accept-time. Indexed on `org_id`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` |
| **FK** org_id | uuid | → `organisations.id` (cascade) |
| **FK** user_id | uuid | → `users.id` (cascade) |
| policy_version | varchar(64) | Snapshot of accepted version |
| policy_text | text | Snapshot of exact text |
| accepted_at | timestamptz | default now() |

### `audit_logs` — RLS on `organisation_id` · append-only
Immutable event trail. `cnap_app` holds SELECT + INSERT only. Nullable org id allows system-level events. Indexed on `organisation_id` and `(entity_type, entity_id)`.

| Column | Type | Notes |
|--------|------|-------|
| **PK** id | uuid | `uuidv7()` |
| **FK IX** organisation_id | uuid `?` | → `organisations.id` (SET NULL) |
| actor_user_id | uuid `?` | Who did it (from OrgStore) |
| action | varchar(64) | create · edit · login · logout · … |
| **IX** entity_type | varchar(64) | e.g. user, organization |
| **IX** entity_id | uuid `?` | Target entity |
| entity_label | text | Human label at event time |
| metadata | jsonb `?` | Holds `changes[]` before/after diffs |
| ip_address | varchar(64) `?` | Captured from request |
| user_agent | text `?` | Captured from request |
| created_at | timestamptz | default now() |

### RLS & grants summary

| Table | RLS policy | cnap_app grant | cnap_supervisor |
|-------|-----------|----------------|-----------------|
| `roles` | none (reference) | SELECT | SELECT |
| `role_permissions` | none (reference) | SELECT | SELECT |
| `consent_policies` | none (reference) | SELECT | SELECT |
| `organisations` | `id = current_org` | SELECT/INSERT/UPDATE/DELETE | SELECT all |
| `users` | `org_id = current_org` | SELECT/INSERT/UPDATE/DELETE | SELECT all |
| `consent_acceptances` | `org_id = current_org` | SELECT/INSERT/UPDATE/DELETE | SELECT all |
| `audit_logs` | `organisation_id = current_org` | SELECT/INSERT (append-only) | SELECT all |

---

## 6. RBAC permission matrix

The single source of truth: 9 roles across 12 modules. Each cell shows the granted actions — **R**ead, **W**rite, **C**reate, **A**pprove, **E**xport, **S**hare. A dash means no access. Roles marked ×-entity can read across organisations.

| Role | entityTeam | rolesPerm | onboardConsent | methodQBank | studySurvey | dataColl | dataImport | citizenCh | aiReview | priorityScore | reports | archiveAudit |
|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| NGO Admin | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES | RWCAES |
| Research Officer | – | – | – | R | RWCE | RWC | RWC | – | R | R | RE | – |
| Field Researcher | – | – | – | R | R | RWC | – | – | – | – | – | – |
| Human Reviewer | – | – | – | R | R | R | R | R | RWA | R | – | – |
| Data Analyst | – | – | – | R | R | R | RWC | – | R | RWCAE | RWCE | R |
| System Admin ×-entity | RWCE | R | R | R | R | R | R | R | R | R | R | R |
| Read-only Viewer | – | – | – | R | R | R | R | – | R | R | RE | R |
| Center Supervisor ×-entity | R | – | – | R | R | R | R | – | R | R | RE | R |
| Citizen Guest (no login) | – | – | – | – | – | – | – | C | – | – | – | – |

Citizen Guest is a public data source (submits a need via the citizen channel), not a login-capable account — it is excluded from user assignment.

---

## 7. Not yet built

The delivered scope is the identity / RBAC / org / user / audit foundation. The following are scoped and planned but not implemented:

- **OTP staff login + forgot / reset password** — blocked on a mail/SMS provider.
- **The PRD assessment pipeline** — studies → define-need (AI) → survey-from-bank → data collection → 5-level scoring → Top-5 priorities → evidence → three reports (PDF/Excel) → sharing → supervisor review.
- **dataImport & citizenChannel features** — permissions are seeded but the features are intentionally inert this phase.
- **Production hardening** — CA-signed TLS certificates, rotated secrets, encrypted storage volumes, load/soak and penetration testing.

> **Verification gate:** every change lands only when `pnpm test` (82 tests, real DB) and `pnpm build` are both green. The requirement→implementation→test mapping is maintained in [`docs/traceability-matrix.md`](./traceability-matrix.md).

---

*CNAP API · Community Needs Assessment Platform (Project Rio) · internal engineering report · compiled 2026-07-13 from branch `main` (merge `99b7335`).*
