# RIO Backend — Plain-English Guide

One file, no jargon required. If you can read a spreadsheet, you can follow this.

Stack: NestJS (the web server framework) + Prisma (talks to the database) + PostgreSQL (the database).

---

## 1. The big picture

Every NGO ("Organisation") that signs up gets its own private slice of data. A researcher
at one NGO can never see another NGO's studies, users, or files — this is enforced by the
**database itself** (Row-Level Security / RLS), not just by application code. Even if a bug
in our code forgot to filter by organisation, Postgres would still refuse to return rows
that don't belong to the caller's org. This is explained in detail in [Section 5](#5-multi-tenancy--how-data-stays-private-per-ngo).

The main workflow the backend supports (added in "Week 2") is:

```
Create Study → Capture Need → Upload Evidence → Submit Evidence → AI Classification → Human Review
```

Each arrow is a real API call, and each one moves a `Study` row's `status` field forward.
Nothing skips a step — you can't classify a study that has no Need, and you can't submit
evidence before it's uploaded.

---

## 2. Every database table, in plain terms

| Table | What it stores | Created |
|---|---|---|
| `roles` / `role_permissions` | The fixed list of roles (NGO Admin, Researcher, Reviewer, Supervisor, etc.) and what each role can read/write/approve per module. Seeded once, never edited by users. | original schema |
| `consent_policies` | The versioned text of the privacy/consent agreement users must accept. | original schema |
| `organisations` | One row per NGO. Name, purpose, registration number, sector, region(s), logo, villages list. `region` is a list of strings (an NGO can span more than one region), not a single comma-separated string. | original schema, later widened (see §3) |
| `users` | One row per person. Belongs to exactly one organisation and one role. | original schema |
| `consent_acceptances` | A permanent record of "this user accepted this exact policy text at this exact time." | original schema |
| `audit_logs` | Every create/edit/delete anyone does, anywhere in the app, with before/after values. Append-only — nothing is ever updated or deleted from this table. | original schema |
| **`studies`** | One row per Study. Title, status, which villages it covers, who created it. | Week 2 |
| **`needs`** | The single "statement of need" for a Study — what problem is being documented, which village(s), and the source of that information. `village` is a list of strings (a Need can name more than one village), not a single comma-separated string. | Week 2 |
| **`evidence`** | One row per uploaded supporting file (PDF/CSV/XLS/XLSX/DOC/DOCX/JPG/JPEG/PNG) attached to a Study. | Week 2 |
| **`ai_decisions`** | One row per AI Classification run, holding both the AI's suggestion and (once reviewed) the human reviewer's decision — on the *same* row, so the audit trail never loses the AI's original suggestion even after a human overrides it. | Week 2 |

### Schema diagram

Boxes are tables, lines are relationships. `PK` = the row's own id, `FK` = a column that
points to another table's `PK`. Tables added in Week 2 are `studies`, `needs`, `evidence`,
`ai_decisions` (the bottom cluster) — everything else already existed.

```mermaid
erDiagram
    ORGANISATION ||--o{ USER : "employs"
    ORGANISATION ||--o{ CONSENT_ACCEPTANCE : "has"
    ORGANISATION ||--o{ AUDIT_LOG : "has"
    ORGANISATION ||--o{ STUDY : "owns"
    ORGANISATION ||--o{ NEED : "owns"
    ORGANISATION ||--o{ EVIDENCE : "owns"
    ORGANISATION ||--o{ AI_DECISION : "owns"

    ROLE ||--o{ ROLE_PERMISSION : "grants"
    ROLE ||--o{ USER : "assigned to"

    USER ||--o{ CONSENT_ACCEPTANCE : "accepts"

    STUDY ||--o| NEED : "has exactly one"
    STUDY ||--o{ EVIDENCE : "has many"
    STUDY ||--o{ AI_DECISION : "has many"

    ORGANISATION {
        uuid id PK
        string name
        string purpose
        string registration_number "unique"
        string sector
        string_array region
        string logo_url
        string_array villages
        boolean is_active
    }

    ROLE {
        string id PK
        string key "unique"
        string name
        boolean cross_entity
    }

    ROLE_PERMISSION {
        uuid id PK
        string role_id FK
        string module
        boolean read
        boolean write
        boolean create
        boolean approve
        boolean export
        boolean share
    }

    CONSENT_POLICY {
        uuid id PK
        string version "unique"
        string text
        boolean active
    }

    USER {
        uuid id PK
        uuid org_id FK
        string role_id FK
        string name
        string email "unique"
        string status
        string password_hash
        boolean must_change_password
        datetime consented_at
    }

    CONSENT_ACCEPTANCE {
        uuid id PK
        uuid org_id FK
        uuid user_id FK
        string policy_version
        string policy_text
        datetime accepted_at
    }

    AUDIT_LOG {
        uuid id PK
        uuid organisation_id FK
        uuid actor_user_id
        string action
        string entity_type
        uuid entity_id
        string entity_label
        json metadata
    }

    STUDY {
        uuid id PK
        uuid org_id FK
        string title
        string_array villages
        string status
        uuid created_by
    }

    NEED {
        uuid id PK
        uuid study_id FK "unique — one Need per Study"
        uuid org_id FK
        string statement
        string_array village
        string source
        uuid created_by
    }

    EVIDENCE {
        uuid id PK
        uuid study_id FK
        uuid org_id FK
        string file_name
        string file_type
        int file_size
        string storage_key
        uuid uploaded_by
        datetime uploaded_at
    }

    AI_DECISION {
        uuid id PK
        uuid org_id FK
        uuid study_id FK
        string touchpoint
        string subject_type
        uuid subject_id
        string model_name
        string model_version
        json suggestion "AI's domains/sub-domains/rationale"
        decimal confidence
        json human_decision "reviewer's decision, added later"
        uuid decided_by
        datetime decided_at
    }
```

### Rules baked into the tables themselves (not just app code)

- **One Need per Study** — the database has a *unique* constraint on `needs.study_id`. It is
  physically impossible to insert a second Need for the same Study, even if application code
  had a bug that tried.
- **One AI Classification can hold many suggested domains** — `ai_decisions.suggestion` stores
  a list (`domains: string[]`, `subDomains: string[]`), so the AI can suggest multiple
  categories for one Need. This is different from "multiple Needs," which is not allowed.
- Every tenant-owned table (`studies`, `needs`, `evidence`, `ai_decisions`, `users`,
  `consent_acceptances`) carries an `org_id` column that Postgres RLS checks on every single
  query — see §5.
- **Villages and regions are real lists, not comma-separated strings** — `needs.village` and
  `organisations.region` are Postgres `TEXT[]` columns. Typing "Al Wathba, Al Falah, Bani Yas"
  into the Village field produces three separate array elements, not one literal string that
  happens to contain commas. (This used to be a single `VARCHAR` column for both — a real bug,
  fixed in the migration described in §3, which also split any already-existing
  comma-separated values into proper array elements.)

---

## 3. What actually changed in this pass (one migration)

Database changes are called "migrations" — small, ordered SQL scripts that update the table
structure. Everything for Week 2 (Study/Need/Evidence/AI Classification) lives in a single
migration, **`20260714120000_week2_data_capture`**:

- Creates the four new tables (`studies`, `needs`, `evidence`, `ai_decisions`) from scratch,
  in their final shape — `needs.village`/`studies.villages` as real lists (`TEXT[]`),
  `evidence.file_size` already present, and the `StudyStatus` enum already using
  `evidence_submitted` (not an intermediate `evidence_uploaded` value that gets renamed
  later) — plus their RLS policies and permissions.
  - This was originally written and applied as 4 separate migrations over a few days; since
    none of them had been committed to git yet, they were squashed into this one file in its
    final form rather than keeping the (never-shared) intermediate steps around forever.
- Widens `organisations.region` from a single `VARCHAR` to a real list (`TEXT[]`) — that
  column predates this migration (added, nullable, by the original `init_domain` migration),
  so this part is a genuine `ALTER COLUMN`, not something folded into a fresh `CREATE TABLE`.
  Any pre-existing comma-separated value is split into proper array elements automatically.

Organisation profile fields (`purpose`, `registration_number`) and auth/signup fields were
widened in an earlier, separate migration in the same Week 2 effort — see §7.

No tables were dropped. No existing data was destroyed by this migration.

---

## 4. Creating a Study, step by step — what the backend actually does

This is the exact sequence a Researcher goes through, and what happens server-side at each step.

### Step 1 — `POST /studies` (Create Study)
Body: just `{ title }` (villages can optionally be sent too, but the frontend currently only
sends the title). Creates a `studies` row with `status = 'draft'`.

### Step 2 — `POST /studies/:id/need` (Capture Need)
Body: `{ statement, village, source }` — `village` is a list of strings (at least one
required), not a single string. Because of the database's unique constraint, this fails with
a clear error if a Need already exists for this Study. On success, the Study's status
automatically moves to `need_captured`.

### Step 3 — `POST /studies/:id/evidence` (Upload Evidence)
Accepts one or more files. Before saving anything, the server checks:
- **File type** — only `.pdf .csv .xls .xlsx .doc .docx .jpg .jpeg .png`. Anything else is
  rejected.
- **File size** — max 10MB per file.
- **File count** — max 10 files per Study, total (not per upload — if you already have 8
  files, you can only add 2 more).

Uploading **does not** change the Study's status by itself (this was a deliberate business
decision — see the note in the code, attributed to "Ganesh"). Files are saved to local disk
for now (`storageKey` is just a filename); swapping to cloud storage later needs no schema
change.

### Step 4 — `POST /studies/:id/evidence/submit` (Submit Evidence)
This is a separate, explicit action a Researcher takes once they're done uploading. It
checks that a Need exists and at least one file has been uploaded, then moves the Study's
status to `evidence_submitted`. Calling it again later (e.g. after adding more files) is
harmless — it just does nothing if the status has already moved past this point.

**Why upload and submit are two separate steps:** so that a Researcher can upload files
across multiple sessions without accidentally triggering AI Classification (which is gated
on submission, not on upload) before they're actually ready.

### Step 5 — `POST /studies/:id/classify` (AI Classification)
Only allowed once the Study is at `evidence_submitted` or further — trying to classify a
Study still at `draft`/`need_captured` returns a clear `409 EVIDENCE_NOT_SUBMITTED` error.

What happens: the Need's statement is stripped of anything that looks like an email address
or phone number (basic PII redaction, done in code — see §6), then handed to the classifier.
A row is written to `ai_decisions` holding the suggestion, and the Study's status moves to
`ai_classified`.

### Step 6 — `PATCH /ai-decisions/:id/review` (Human Review)
A reviewer either **approves** the AI's suggestion as-is, or **overrides** it (supplying
their own domains/sub-domains and a mandatory reason). Either way this is written onto the
*same* `ai_decisions` row (not a new row) as `humanDecision`, and the Study's status moves to
its final stage, `human_reviewed`.

### Deleting a Study
A Study can only be deleted while it's still `draft`, `need_captured`, or
`evidence_submitted`. Once it's been `ai_classified` or `human_reviewed`, deletion is blocked
(`409 STUDY_NOT_DELETABLE`) — the reasoning being that once AI/human decisions reference it,
other people may be relying on that record.

---

## 5. Multi-tenancy — how data stays private per NGO

Two safety nets, not one:

1. **Application code** always scopes queries to "the current caller's organisation" via a
   helper called `requireOrgId()`.
2. **The database itself** enforces the same rule independently, via Postgres Row-Level
   Security. Every tenant table has a policy that says, roughly: *"you may only see/change
   rows where `org_id` matches the organisation currently set for this connection."* This
   is turned on with `FORCE ROW LEVEL SECURITY`, meaning it applies even to the app's own
   database user — there is no backdoor.

So even a coding mistake that forgot to filter by organisation would still come back empty —
Postgres itself is the last line of defense, not just a nice-to-have.

There's also a special **read-only cross-org role** (`cnap_supervisor`) used only by roles
like "Center Supervisor" that are explicitly meant to see across every NGO — it can `SELECT`
from any organisation's rows, but cannot write anything, ever.

---

## 6. AI Classification & Scoring — what's real vs. placeholder

**Be direct about this with stakeholders:** none of the "AI" in this phase is a trained
model. It's a placeholder that always returns the same thing, and it exists so that the
rest of the workflow (Human Review, statuses, the UI) has something real to plug into once
an actual model is ready.

- **Classification placeholder** (`classification.placeholder.ts`) — always returns
  `domains: ["Uncategorized"]`, `subDomains: ["Uncategorized"]`, confidence `0`, and a
  rationale string that literally says *"Placeholder classification pending business rules
  and LLM integration."* The one real piece of logic it does perform: stripping anything
  that looks like an email or phone number out of the Need's statement before it would be
  sent to a model.
- **Scoring placeholder** (`scoring.placeholder.ts`) — even simpler: there's no "Survey
  Response" data yet to score against, so this doesn't write anything to the database at
  all. It just returns `{ status: "pending", message: "Scoring engine will be implemented
  after business rules are finalized." }`.

When the real model/scoring rules are ready, only these two files need to change — the
database shape (`ai_decisions.suggestion` as a flexible JSON column) was deliberately built
to not need a schema change for that swap.

---

## 7. Everything else touched this pass (briefly)

- **Organisations** — added `purpose` (free text, used when an NGO's sector is "Other") and
  `registration_number` (unique — this is what prevents the same NGO signing up twice and
  creating a duplicate admin account).
- **Auth / Signup** — public NGO self-signup now accepts `sector` and `purpose`; a temporary
  password is generated, emailed if possible, and the user must change it on first login.
- **Audit log** — every module above (Studies, Needs, Evidence, AI Decisions, Organisations)
  writes to `audit_logs` on every create/edit/delete, including a before/after diff of which
  fields changed. This is what powers the Audit Log screen in the UI.
- **Consent** — unrelated to Studies; tracks acceptance of the platform's privacy policy per
  user, versioned so we always know exactly which wording someone agreed to.
- **Village/region arrays** — fixed a real bug where typing several villages/regions
  separated by commas was stored as one literal string instead of being treated as separate
  values (see §2's "Rules baked into the tables" and §3).
- **Evidence file types** — JPG/JPEG/PNG were added to the accepted evidence file types,
  alongside PDF/CSV/XLS/XLSX/DOC/DOCX (see `evidence.storage.service.ts`).

---

## 8. Where to look in the code, if you need to go deeper

| Question | File |
|---|---|
| What columns exist on every table? | `prisma/schema.prisma` |
| What actually changed in the database, in order? | `prisma/migrations/*/migration.sql` (read folder names in order — they're timestamped) |
| What happens when a Study is created/edited/deleted? | `src/modules/studies/studies.service.ts` |
| What happens when a Need is captured? | `src/modules/needs/needs.service.ts`, `needs.contract.ts` (village-as-list validation) |
| Evidence upload rules (file type/size/count) | `src/modules/evidence/evidence.storage.service.ts` |
| Evidence upload → submit → status flow | `src/modules/evidence/evidence.service.ts` |
| AI Classification + Human Review logic | `src/modules/ai-decisions/ai-decisions.service.ts` |
| The (fake, for now) AI logic itself | `src/modules/ai-decisions/classification.placeholder.ts`, `scoring.placeholder.ts` |
| How org-isolation actually works | `src/tenancy/org-context.ts`, `src/tenancy/tenant-prisma.service.ts` |
| Signup / login | `src/modules/auth/auth.service.ts` |
