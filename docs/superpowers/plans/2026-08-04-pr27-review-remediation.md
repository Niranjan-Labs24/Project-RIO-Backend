# PR 27 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR 27 deployable and eliminate its validated data-integrity, authorization-boundary, report-input, file-lifecycle, and HTTP defects.

**Architecture:** Keep the existing NestJS/Prisma service boundaries. Strengthen them with database invariants, route-scope-aware service queries, canonical file metadata, and strict confirmed-input validation; every behavioral change begins with a focused regression test.

**Tech Stack:** NestJS 11, TypeScript 5.9, Prisma 7/PostgreSQL, Vitest 4, pnpm 10.

## Global Constraints

- Work only on the local `Ayush` branch based on `origin/Ayush`.
- Preserve tenant isolation through `TenantPrismaService.runInOrgContext` and PostgreSQL RLS.
- `.txt`, `.docx`, `.pdf`, `.csv`, and `.xlsx` remain supported evidence formats.
- Do not introduce fabricated evidence or accept draft summaries as confirmed inputs.
- Do not push without explicit authorization.

---

### Task 1: Complete the evidence persistence migration

**Files:**
- Modify: `prisma/migrations/20260803120000_add_rpt16_rpt17_evidence_reports/migration.sql`
- Create: `test/pr27-migration.spec.ts`

**Interfaces:**
- Consumes: the five model/table mappings in `prisma/schema.prisma`.
- Produces: deployable DDL for all five tables and partial unique indexes named `evidence_document_one_confirmed` and `combined_report_one_confirmed`.

- [ ] **Step 1: Write a failing migration contract test**

Read the migration text and assert it contains `CREATE TABLE` for all five mapped table names, `ENABLE ROW LEVEL SECURITY` for each, foreign keys, and the two partial indexes with `WHERE status = 'OFFICER_CONFIRMED'`.

- [ ] **Step 2: Run the contract test and verify failure**

Run: `pnpm.cmd test -- test/pr27-migration.spec.ts`
Expected: FAIL because the migration currently contains only two `ALTER TYPE` statements.

- [ ] **Step 3: Add exact PostgreSQL DDL**

Add columns matching the Prisma mappings and types, UUID defaults using `uuidv7()`, cascading foreign keys, schema-declared indexes, and partial unique confirmation indexes. Follow existing migration policy syntax using `current_setting('app.current_org_id', true)::uuid`; child-table policies must scope through their parent evidence/combined-summary row.

- [ ] **Step 4: Run migration and schema checks**

Run: `pnpm.cmd test -- test/pr27-migration.spec.ts`
Expected: PASS.

Run with a placeholder URL: `$env:DATABASE_URL='postgresql://review:review@localhost:5432/review'; pnpm.cmd exec prisma validate`
Expected: schema valid.

- [ ] **Step 5: Commit**

```powershell
git add prisma/migrations/20260803120000_add_rpt16_rpt17_evidence_reports/migration.sql test/pr27-migration.spec.ts
git commit -m "fix(db): create evidence report persistence"
```

### Task 2: Validate confirmed combined-report inputs

**Files:**
- Modify: `src/modules/reports/combined-report-summary.service.spec.ts`
- Modify: `src/modules/reports/combined-report-summary.service.ts`

**Interfaces:**
- Consumes: `generateCombinedSummary(studyId: string, documentSummaryIds: string[], scoreSummaryId?: string)`.
- Produces: generation that rejects missing, duplicate-only, cross-study, draft, or unmatched summary IDs and passes only persisted evidence to the AI task.

- [ ] **Step 1: Add failing regression tests**

Add cases asserting: an unmatched requested ID throws `BadRequestException`; a draft document summary is rejected; a draft/cross-study score summary is rejected; zero matched summaries never calls `aiService.runTask`; generated prompt inputs contain no `Field Report`, `REF-001`, or invented health-shortage fallback.

- [ ] **Step 2: Verify the new tests fail**

Run: `pnpm.cmd test -- src/modules/reports/combined-report-summary.service.spec.ts`
Expected: FAIL on unmatched/draft selection and fabricated fallback behavior.

- [ ] **Step 3: Implement strict selection**

Normalize IDs with `const requestedIds = [...new Set(documentSummaryIds ?? [])]`; reject empty input; query summaries using `id: { in: requestedIds }`, `studyId`, and `status: 'OFFICER_CONFIRMED'`; require `rows.length === requestedIds.length`. Apply the same study/status validation to `scoreSummaryId`. Build prompt fields and audit metadata only from validated rows and remove all fictional fallbacks.

- [ ] **Step 4: Verify service tests pass**

Run: `pnpm.cmd test -- src/modules/reports/combined-report-summary.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/reports/combined-report-summary.service.ts src/modules/reports/combined-report-summary.service.spec.ts
git commit -m "fix(reports): validate confirmed summary inputs"
```

### Task 3: Enforce nested study and document boundaries

**Files:**
- Modify: `src/modules/evidence/evidence-documents.controller.ts`
- Modify: `src/modules/evidence/evidence-documents.service.ts`
- Modify: `src/modules/evidence/document-summary.service.ts`
- Modify: `src/modules/evidence/evidence-documents.service.spec.ts`
- Modify: `src/modules/evidence/document-summary.service.spec.ts`
- Modify: `src/modules/reports/combined-report-summary.controller.ts`
- Modify: `src/modules/reports/combined-report-summary.service.ts`
- Modify: `src/modules/reports/combined-report-summary.service.spec.ts`

**Interfaces:**
- Produces scope-aware methods such as `getDocumentDetails(studyId, id)`, `generateDocumentSummary(studyId, documentId)`, `updateDraftSummary(studyId, documentId, summaryId, body)`, and `confirmCombinedSummary(studyId, summaryId)`.

- [ ] **Step 1: Add failing scope tests**

Assert every lookup/update includes route `studyId`; document-summary mutations include both `documentId` and `summaryId`; combined-summary mutations include `studyId`. Assert a mismatch yields `NotFoundException` and performs no update.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm.cmd test -- src/modules/evidence/evidence-documents.service.spec.ts src/modules/evidence/document-summary.service.spec.ts src/modules/reports/combined-report-summary.service.spec.ts`
Expected: FAIL because current methods accept identifiers without route scope.

- [ ] **Step 3: Thread route identifiers into services**

Update controller parameter passing and service signatures. Use `findFirst({ where: { id, studyId } })` and relation-aware summary filters such as `{ id: summaryId, documentId, studyId }`; do not rely solely on tenant RLS because studies within one tenant remain distinct authorization resources.

- [ ] **Step 4: Run focused tests**

Run the command from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/evidence src/modules/reports/combined-report-summary.controller.ts src/modules/reports/combined-report-summary.service.ts src/modules/reports/combined-report-summary.service.spec.ts
git commit -m "fix(authz): scope evidence mutations to study routes"
```

### Task 4: Correct file types and evidence cleanup

**Files:**
- Modify: `src/modules/evidence/evidence.storage.service.ts`
- Modify: `src/modules/evidence/evidence.storage.service.spec.ts`
- Modify: `src/modules/evidence/evidence-documents.service.ts`
- Modify: `src/modules/evidence/evidence-documents.service.spec.ts`
- Modify: `src/modules/evidence/evidence-documents.controller.ts`

**Interfaces:**
- Produces: exported `EVIDENCE_FILE_TYPES: Readonly<Record<string, string>>`, including `.txt: 'text/plain'` and canonical MIME types for every supported extension.

- [ ] **Step 1: Add failing lifecycle and MIME tests**

Test `.txt` storage acceptance; persisted `fileType` equals a MIME type; upload calls `storage.remove(storageKey)` if parsing or DB creation throws; deletion calls `storage.remove`; controller download sends `application/pdf` rather than `.pdf`.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm.cmd test -- src/modules/evidence/evidence.storage.service.spec.ts src/modules/evidence/evidence-documents.service.spec.ts`
Expected: FAIL on `.txt`, MIME persistence, and cleanup assertions.

- [ ] **Step 3: Implement canonical metadata and cleanup**

Replace duplicate allowlists with `EVIDENCE_FILE_TYPES`. Validate study/link relations before saving. Wrap post-save parse/persist work in `try/catch`, remove the key on failure, and rethrow. On deletion, retain the storage key, delete the database row, then call `storage.remove`; propagate cleanup failures so they can be retried rather than silently ignored.

- [ ] **Step 4: Run evidence tests**

Run the command from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/evidence
git commit -m "fix(evidence): align MIME types and file cleanup"
```

### Task 5: Make summary confirmation atomic

**Files:**
- Modify: `src/modules/evidence/document-summary.service.spec.ts`
- Modify: `src/modules/evidence/document-summary.service.ts`
- Modify: `src/modules/reports/combined-report-summary.service.spec.ts`
- Modify: `src/modules/reports/combined-report-summary.service.ts`

**Interfaces:**
- Consumes: partial unique indexes from Task 1.
- Produces: one `runInOrgContext` transaction per confirmation containing read, supersede, and confirm operations.

- [ ] **Step 1: Add failing transaction tests**

Assert each confirm method invokes `runInOrgContext` once, performs lookup/updateMany/update through the provided single transaction client, and maps Prisma unique-constraint errors to `ConflictException`.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm.cmd test -- src/modules/evidence/document-summary.service.spec.ts src/modules/reports/combined-report-summary.service.spec.ts`
Expected: FAIL because confirmation currently spans multiple transactions.

- [ ] **Step 3: Consolidate each confirmation operation**

Move lookup, supersede, and final update into one `runInOrgContext(async tx => ...)` callback. Keep route-scope predicates from Task 3. Catch `Prisma.PrismaClientKnownRequestError` with code `P2002` and throw a clear `ConflictException` instructing the caller to refresh.

- [ ] **Step 4: Run confirmation tests**

Run the command from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/modules/evidence/document-summary.service.ts src/modules/evidence/document-summary.service.spec.ts src/modules/reports/combined-report-summary.service.ts src/modules/reports/combined-report-summary.service.spec.ts
git commit -m "fix(ai-review): make confirmations atomic"
```

### Task 6: Remove diagnostic artifact and run release verification

**Files:**
- Delete: `diag.txt`
- Modify only if required by verified failures: directly affected files from Tasks 1-5.

**Interfaces:**
- Produces: a clean, buildable Ayush branch with no reviewed findings remaining.

- [ ] **Step 1: Remove the diagnostic artifact**

Use `apply_patch` to delete `diag.txt`.

- [ ] **Step 2: Install and generate deterministically**

Run: `pnpm.cmd install --frozen-lockfile`

Run: `$env:DATABASE_URL='postgresql://review:review@localhost:5432/review'; npm run prisma:generate`

- [ ] **Step 3: Run the affected tests**

Run: `pnpm.cmd test -- test/pr27-migration.spec.ts src/modules/ai/ai.task.spec.ts src/modules/evidence/evidence.storage.service.spec.ts src/modules/evidence/evidence-documents.service.spec.ts src/modules/evidence/document-summary.service.spec.ts src/modules/reports/combined-report-summary.service.spec.ts src/modules/reports/report-doc.rpt16.spec.ts src/modules/reports/report-doc.rpt17.spec.ts src/modules/reports/reports.service.spec.ts`
Expected: all pass.

- [ ] **Step 4: Run static verification**

Run: `pnpm.cmd lint`
Expected: zero errors.

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run build`
Expected: exit 0.

Run: `git diff --check origin/Ayush...HEAD`
Expected: no whitespace errors.

- [ ] **Step 5: Commit cleanup and any verification-only corrections**

```powershell
git add -u
git commit -m "chore: remove committed diagnostic output"
```

- [ ] **Step 6: Re-review the resulting branch**

Review `origin/main...HEAD` for the original nine findings and report exact verification results. Do not push until the user explicitly requests it.
