# Session Report — Need & Evidence Backend Work

**Date:** 2026-07-23 · **Scope:** `Project-RIO-Backend` only · **Modules touched:** `needs`, `evidence`

This report covers work done across a multi-day session: verifying an implementation plan against the real codebase, implementing `Need.title`/`source` lock and `Evidence.fileHash`/duplicate-detection/delete-lock, and (after the codebase evolved substantially underneath, via other work landing in parallel) rewriting unit test coverage to match current code. It also documents environment issues discovered along the way that are **not yet fixed** and need a decision.

---

## 1. What was verified first

Before any code was written, an earlier "RIO — Implementation Plan v2" document was checked line-by-line against the actual code (27 claims, via a dedicated research pass). Headline findings:

- **Consent (post-login, versioned)** was already fully implemented — signup already stamped `consentedAt`/created `ConsentAcceptance` atomically, `GET /organizations/current` already existed. The plan's premise there was stale.
- **Study/Need/Evidence frontend UI did not exist at all** on `Project-RIO-Frontend` — no create forms, no Evidence upload screen. Confirmed via exhaustive grep/glob; this is still true as of this report (see §5).
- **Domain/Subdomain as DB-backed entities** and the **Need lock-by-status policy** were genuinely not built yet at that time — both have since been built (see §4).
- Evidence file-type/size limits (10MB, 10 files, `.doc`/`.jpeg` included) were already correct.

## 2. `Need.title` + `source` lock (implemented, then superseded by a larger rework)

Original scope: add `title` to `Need`, make `source` fully system-set (removed from `CreateNeedBody`/`UpdateNeedBody`, service hardcodes `'manual_entry'`).

- Migration `20260716120909_need_title_and_source_lock` — later **rewritten by other work** to properly backfill `title` from the parent `Study` (lifting `NO FORCE ROW LEVEL SECURITY` for the backfill `UPDATE`, since `needs` is FORCE-RLS and the naive `UPDATE` would silently match zero rows during a migration with no `app.current_org_id` set). The current migration file backfills correctly rather than requiring an empty table.
- This work has since been **superseded** by a much larger Need rework (§4) — a Study can now hold many Needs, not one.

## 3. `Evidence.fileHash` + duplicate detection + delete lock (implemented, still current)

Three incremental slices, each confirmed against real code before building:

1. **`fileHash` column** (`VarChar(64)`, sha256 hex) — computed via `EvidenceStorageService.hashBuffer()` from the in-memory upload buffer (never re-read from disk), persisted on `EvidenceService.upload()`. Migration `20260716122933_evidence_file_hash`.
2. **Duplicate detection** — scoped originally to `studyId` (a Study had exactly one Need at the time); `upload()` seeds a hash set from existing rows and grows it as the batch is processed, so a repeat within the same request is caught too. Response gains `isDuplicate?: boolean` (upload-response-only; `listByNeedId`/`listByStudyId` don't include it — that flag only answers "did this exist *when uploaded*", an order-dependent question that doesn't generalize to a plain list).
3. **Delete lock** — `EvidenceService.remove()` used to delete unconditionally. It now mirrors `StudiesService.remove()`'s shape: existence check → status check → delete, blocking with `409 EVIDENCE_NOT_DELETABLE` once the parent record is past its editable status.
   - **Frontend half explicitly skipped** — `evidence/page.tsx` (referenced in the original task) does not exist anywhere in `Project-RIO-Frontend`; confirmed by exhaustive search, twice, on different days. Still true as of this report.

These three are backend-complete and match current code (verified in §6, not just claimed).

## 4. Codebase evolution noticed mid-session (not this session's work, but now load-bearing)

Between one working session and the next, the Need/Evidence surface grew substantially — this report documents the current shape rather than re-litigating it:

- **A Study can hold many Needs** (the old `Need.studyId @unique` 1:1 constraint is gone). Routes moved: collection ops under `studies/:studyId/needs`, item ops under `needs/:needId` (a Need doesn't move between Studies).
- **`Need` now carries `domain`/`subDomain` directly** (mandatory on manual create), plus `aiSuggestedDomain`/`aiSuggestedSubDomain` (AI Classification's own suggestion, display-only), `referenceId` (external tracking id, dedup key), and a `NeedStatus` workflow: `draft → evidence_submitted → ai_classified → reviewer_approved → survey_created → survey_published`.
- **`NEED_EDITABLE_STATUSES = ['draft']`** — both `NeedsService.update/remove` and `EvidenceService.remove` (via the parent Need's status) now gate on this single constant, replacing the old two-status (`draft`/`need_captured`) window.
- **`Evidence` is now scoped by `needId`** (not just `studyId`) — `fileHash` is also now `String | null` (nullable, for rows predating the column; duplicate detection filters nulls out rather than treating them as a match).
- **A new `NeedsImportService`/`needs-import.parser.ts`** (CSV/XLSX bulk import, dedup by `referenceId` or title+village, per-row validation) landed with **zero test coverage** — explicitly scoped out of this session's testing work (see §5), by your choice when asked.

## 5. Unit tests — completed and passing

Because the code above changed after the original tests were written, and those spec files were no longer present on disk, all three were rewritten from scratch against current behavior. Scope was explicitly narrowed, on request, to the two services (not the new import module).

| File | Tests | Coverage |
|---|---|---|
| `src/modules/needs/needs.service.spec.ts` | 15 | `create` (404, multi-Need-per-Study allowed, `source` forced, domain/subDomain stored, referenceId default/explicit, audit label), `listByStudyId`, `getById` (404 + full field mapping incl. AI-suggested fields), `update` (404, 409 parametrized across all 5 non-draft statuses, labeled diff, explicit `referenceId: null`, no-op skips audit), `remove` (404, deletes while draft, 409 parametrized across all 5 non-draft statuses) |
| `src/modules/evidence/evidence.service.spec.ts` | 14 | `upload` (404 no Need, 409 over limit, hash + `needId`/`studyId` stamped, duplicate flagging vs. existing rows and within-batch, null legacy hashes ignored, non-matching files never cross-flagged), `remove` (404, deletes while Need is draft, 409 parametrized across all 5 non-draft statuses, defensive null-Need branch) |
| `src/modules/evidence/evidence.storage.service.spec.ts` | 3 | `hashBuffer` against real `node:crypto` sha256 (correct digest, deterministic, differs by content) |

**Result:** `pnpm exec vitest run src/modules/needs src/modules/evidence` → **3 files, 42 tests, all passing.** `tsc --noEmit -p tsconfig.build.json` clean for these modules (spec files are excluded from that build config project-wide, same as every pre-existing spec file).

## 6. Environment issues found — flagged, not fixed

None of these are caused by this session's changes; all pre-date it and are unrelated to the Need/Evidence code. Surfacing them here since they affect anyone running the full suite or building this repo right now.

1. **27 migrations are unapplied on this local dev DB.** `prisma migrate status` reports migrations from `20260716093000_dev1_week2_week3_schema` through `20260721072028_deactivate_legacy_duplicate_questions_pt2` as not yet run here — this is what caused two `tenant-isolation.e2e.spec.ts` failures (`users.consented_policy_version does not exist`) in the last full-suite run. **Action needed:** run `prisma migrate dev` (or `migrate deploy`) to catch this DB up — not done yet, since applying 27 migrations wasn't part of what was asked and is worth a deliberate go-ahead rather than a silent side effect of a testing task.
2. **`exceljs` is declared in `package.json` but not installed** — breaks `tsc` type-checking on `needs-import.parser.ts`, `public-surveys.service.ts`, and `reports/excel-builder.ts`. Likely fixed by a plain `pnpm install`, but not attempted since it's outside this session's confirmed scope.
3. **`config.service.spec.ts` expects `mailFrom` to be `'RIO <no-reply@rio.local>'`** but the local `.env` has a real address (`RIO Platform <zylenkk20@gmail.com>`) — either the test's hardcoded expectation is stale or the local `.env` shouldn't have a real address in it for a spec that asserts defaults. Not touched.

## 7. Still outstanding (by design, not oversight)

- No frontend Evidence/Need UI exists yet — nothing to wire the `isDuplicate` notice or delete-lock button into.
- `NeedsImportService`/`needs-import.parser.ts` have no test coverage (explicit scope decision this session).
- Duplicate-detection scope note: it's currently `needId`-scoped (correct for the current one-Need-per-Study-no-longer-true world); worth double-checking this is still the intended scope now that a Study can hold many Needs, versus scoping to `studyId` across all of a Study's Needs.
