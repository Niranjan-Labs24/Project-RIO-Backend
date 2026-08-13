# Methodology baseline & change control — RIO-AI-005 (legacy FR-19)

> **Requirement:** *"Use the approved methodology package and received study data as the
> baseline for implementation — domains, sub-domains, indicators, KPIs, questions, answer types,
> priority levels, and dashboard/report linkage."*
>
> **Acceptance criteria:** (1) approved methodology is configured in the platform;
> (2) studies and surveys use the approved baseline; (3) **any future change goes through
> versioning / change control**. This file is how (3) is satisfied.

This directory holds the machine-readable form of one signed-off methodology version. Nothing
here is hand-written — every file is regenerated from the client's workbook by
`scripts/extract-methodology-v5.py`, so the baseline is reproducible and diffable rather than
being a one-off load nobody can re-derive.

## Files

| File | Contents |
|---|---|
| `question-bank-v5.json` | 193 questions + the 9-domain / 44-sub-domain hierarchy + reconciled counts |
| `scoring-lookup-v5.json` | 797 option→severity rows (numeric bounds merged one row per question) |
| `domain-priority-v5.csv` | Per-domain priority weights for `import-domain-priority-config.ts` |
| `verification-targets-v5.json` | The workbook's own worked-example outputs, for end-to-end verification |

## The pipeline

```
26-08-02 RIO_Basira_Consolidated_BRD_and_Methodology_V06 1.xlsx   (client's signed-off workbook)
  │
  │  pnpm extract:methodology          — scripts/extract-methodology-v5.py
  ▼
prisma/methodology/*.json + *.csv      (committed artifacts; never hand-edited)
  │
  │  pnpm import:methodology           — creates a DRAFT MethodologyVersion
  │  pnpm import:domain-priority-config --version "<label>" --file methodology/domain-priority-v5.csv
  ▼
questions · scoring_lookups · domains · sub_domains · domain_priority_configs
  │
  │  pnpm import:methodology --publish  (or Settings → Methodology → Publish)
  ▼
status = PUBLISHED  →  selectable by new Studies and Surveys
```

Both steps validate before writing anything. The extractor fails if the workbook's own stated
figures don't reconcile; the importer fails if the artifacts and those figures disagree, if a
scoreable question has no scoring lookup, if a numeric question is missing a bound or direction,
if a severity falls outside 0–100, if a feeder points at an anchor that isn't in the bank, or if a
question's (domain / sub-domain) pair is missing from the hierarchy.

## The counts, and why there are four of them

These describe **one** bank at four scopes — they are not competing totals
(METH — Answer Type Defs, *"Which number to quote"*):

| Count | Meaning |
|---|---|
| **193** | every item in the instrument |
| **186** | field items: 193 − the 7 questionnaire-structure / roster / template modules (XDM-01…07) |
| **185** | items with rows in the Scoring Lookup |
| **184** | questions actually asked of a household: 186 − WSH-15 (administrative record) − SOC-08 (on hold under the sensitivity protocol) |
| **166** | items carrying a severity score (145 index + 20 feeder + XDM-08) |

Plus: **9** domains · **44** sub-domains · **172** indicators · **167** distinct KPI strings ·
**20** feeder items · **18** diagnostic items · **25** conditional rules · **14** roster loops.

⚠️ The workbook's prose says **168** KPIs; the data yields **167** distinct KPI strings. A
one-item discrepancy in the client's own document, recorded here rather than silently rounded.
Worth raising with the methodology owner.

## Change control — the rules

1. **A methodology version is immutable once anything has been scored against it.**
   Both importers refuse to write to a version that has `response_severity_scores` rows. To change
   a scored methodology, create a **new version**; never edit a live one.
2. **An import is not an approval.** `import-methodology.ts` creates the version as `DRAFT`.
   Publishing is a separate, explicit act (`--publish`, or the Settings screen, which records
   `publishedBy` / `publishedAt`).
3. **A published report keeps the version it was measured against.** `Survey.methodologyVersion`
   stores the version **label as a plain string snapshot**, never a live foreign key, so
   publishing a newer methodology can never retroactively change what an existing survey or report
   claims it was built on.
4. **Only a `PUBLISHED` version can be selected** by a new Study or Survey.
5. **Retire, never delete.** `questions.methodology_version_id` is `ON DELETE RESTRICT`. Set
   `status = 'RETIRED'` on a superseded version — its questions, lookups and scores stay
   resolvable forever.
6. **Domains and sub-domains are shared, not version-scoped** — deliberately. They are the
   classification vocabulary for **Needs**, which exist independently of any survey, and
   `Need.domain` / `NeedDomain.domain` store the **name**, not an id. The importer therefore
   *merges* the hierarchy by name (all nine v5.0 domain names match v1.0's exactly, so existing
   rows are reused) and **never** auto-deactivates a sub-domain a version dropped: existing Needs
   may be classified under it. Renamed/retired sub-domains are **reported** at the end of an
   import for a Methodology admin to deactivate via
   `PATCH /domains/:id/subdomains/:subId/deactivate`.

## Why questions are version-scoped

A question's identity is **`(methodologyVersionId, questionId)`**, not `questionId` alone
(migration `20260812090000_methodology_version_scoped_questions`).

Before that, `questions.question_id` was globally unique and the importer never populated
`methodology_version_id`, so every bank shared one flat namespace. Importing a second bank
produced near-identical questions in the same domain/sub-domain that the Survey Builder picker
could not tell apart — and surveys kept selecting the **unscoreable legacy twin** of a real
question. It had to be patched twice with hand-written prefix-regex `UPDATE`s
(`20260721071548_deactivate_legacy_duplicate_questions` and its `_pt2` follow-up, whose comment
records the live symptom: *"a fresh 'Poor Road Connectivity' survey picked legacy I03 instead of
the real IN03"*).

**Do not add a third such migration.** Version scoping replaces that approach entirely. Every
read that feeds the Question Bank picker, AI suggestions, the rollup hierarchy or a report's KPI
denominator filters by methodology version — see `QuestionsService`,
`SurveysService.generateSuggestedQuestions`, `ScoreRollupService`, `PriorityService`,
`report-summary.service.ts`, `load-rpt01-inputs.ts` and `load-segment-severities.ts`.

## Scoring mechanics worth knowing before you touch them

- **Numeric bounds come from the option label, not the severity column.** v5.0 writes
  `Floor=0` / `Ceiling=120` in the *Response Option* cell and puts the severity **at that bound**
  (0 or 100) in the severity column. Direction is therefore *derived*: severity 0 at the floor ⇒
  `WORSENING_HIGHER`; severity 100 at the floor ⇒ `WORSENING_LOWER`. The pre-v5.0 importer read
  the severity column **as** the bound, which inverts all four reversed scales (HLT-04 antenatal
  visits, HLT-07 growth-monitoring visits, EDU-16 attendance days, LIV-03 months of income) and
  flattens INF-09's real floor of 2 to 0.
- **Composite states beat per-option sums.** A `;`-joined option label is one state, not several
  options: INF-14 scores `"Ventilation; Roof; Walls"` = 90, which is *less* than summing its parts
  (Change Summary v5.0 item 8 — *"Checklist items are scored on the composite state"*). The
  workbook enumerates the same set in several orders, so composite keys are **order-independent**:
  each part is normalised, sorted, then joined with `__`. `composite_option_id()` in the extractor
  and `DeterministicScoringService.compositeOptionId()` must stay byte-identical.
- **Multi-select otherwise sums the selected options' severities, capped at 100.**
- **`Don't know` is not the same as an applicability escape.** Only genuine "Don't know" carries
  `DONT_KNOW` and feeds the >20% data-confidence indicator. `Prefer not to answer` and the 17
  eligibility escapes ("No school-age children", "Not eligible", …) leave the denominator without
  implying ignorance.
- **19 of the 25 conditional rules are prose** the engine cannot evaluate ("asked only if a birth
  occurred in the past 24 months"). Those are treated as **applicable** — marking them
  not-applicable would silently discard every answer. The survey instrument enforces prose
  branching in the field.
- **Rule values are reconciled against the parent's real options at extraction time.** The
  workbook says *"asked only if EDU-04 = Yes (once or repeatedly)"* while EDU-04's options are
  `No / Yes, once / Yes, repeatedly`. Left literal, that rule could never be true. Unmatched
  values are recorded in `unmatchedValues`; a rule with **no** match is downgraded to `PROSE`
  rather than left permanently false.
- **Diagnostic items have coded option rows but never score.** The 18 items whose Report Linkage
  reads *"does not enter the scores"* feed gap-type classification only. They resolve as
  `NOT_SCOREABLE`, not as an error and not as 0.

## Domain priority weights

`domain-priority-v5.csv` covers **all nine** domains. The pre-v5.0
`domain-priority-baseline.csv` had only five (Health, Education, Infrastructure, Livelihood,
Water & Sanitation), so a village's priority score was computed from just over half the
methodology and four domains contributed nothing at all.

Two values in that file are **derived decisions, not verbatim workbook figures** — flag them for
the methodology owner:

- **Weights are equal (1/9 ≈ 0.11111).** Methodology §Aggregation: *"Weighting is equal by default
  at every level."* The last row absorbs the rounding remainder so the column sums to exactly
  1.00000, which the importer enforces. If the client wants the pre-v5.0 unequal split extended to
  nine domains instead, that is a change-control decision.
- **`criticalPerformanceThreshold` = 20 for Health and Water & Sanitation.** Derived from
  §Priority Classification: *"Critical Gap (severity 80+ with an access/availability category in
  the Health or Water & Sanitation domains)"* — severity ≥ 80 ⟺ performance ≤ 20. Note the engine
  compares **strictly** (`performance < threshold`), so this fires at severity > 80 rather than
  ≥ 80; whether to shift the boundary is a decision, not a bug to fix silently. Non-critical
  domains keep the previous default of 30.

## Not implemented — deliberately

The workbook leaves these open; building them would go beyond the approved baseline:

- **Strategic factor multipliers** (×1.30 / 1.20 / 1.15 / 1.10) — status is
  *"Proposed — pending confirmation"*. Sent to Dr. Zulfiqar; not signed off. They apply to the
  priority score only and never to severity, with a ×1.30 ceiling and no compounding.
- **Outlier semantics at the ≤40 low end** — *"draft, pending confirmation"*.
- **The facts-vs-perceptions decision rule in aggregation** — deferred to the calibration
  workshop. Fact questions are supposed to be resolved by a documented majority / field
  verification / administrative source rather than averaged; today everything is averaged.
- **A numeric threshold for the equity flag's "materially different"** — the workbook states that
  wording is descriptive, not calibrated.

## Adding the next methodology version

1. Drop the new workbook next to the repo.
2. `python scripts/extract-methodology-v5.py --xlsx "<new workbook>" --version-label "v6.0 - …"`
   — update `EXPECTED_COUNTS` in the script to the new workbook's stated figures **first**, so a
   silent drift fails the extract instead of shipping.
3. Review the artifact diff. This is the actual change-control review: it is a line-by-line diff
   of the methodology, not an opaque reload.
4. `pnpm import:methodology --dry-run` → then without `--dry-run`.
5. `pnpm import:domain-priority-config --version "<label>" --file methodology/domain-priority-v6.csv`
6. Extend `src/modules/priority/methodology-baseline.spec.ts` with the new counts.
7. Publish only after review: `pnpm import:methodology --publish`.
8. Act on the "sub-domains not in this version" list the import prints.
