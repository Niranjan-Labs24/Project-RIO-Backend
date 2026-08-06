# PR 27 Review Remediation Design

## Objective

Make PR 27 safe to deploy and correct the validated database, authorization, evidence lifecycle, report-generation, and HTTP contract defects. Work is based on `origin/Ayush` and remains limited to the reviewed findings.

## Database and tenant isolation

Extend the existing RPT16/RPT17 migration with DDL for `evidence_documents`, `evidence_document_chunks`, `evidence_document_summaries`, `combined_report_summaries`, and `combined_report_evidence_sources`. Add all Prisma-declared foreign keys and indexes, plus the repository's standard row-level-security policies for organization-scoped data and relationship-derived policies for child tables.

Enforce one officer-confirmed document summary per document and one officer-confirmed combined summary per study with partial unique indexes. Confirmation code will supersede prior confirmed rows and confirm the selected row in one organization-context transaction, translating uniqueness races into a conflict response.

## Resource boundaries and report inputs

Nested controller operations will pass `studyId` and, where present in the route, `documentId` into service methods. Services will include these values in resource lookups so a valid same-tenant identifier cannot escape its route scope.

Combined-report generation will canonicalize requested summary IDs, require at least one unique ID, and reject unless every ID resolves to an officer-confirmed summary belonging to the requested study. Score summaries must also be officer-confirmed and study-scoped. Prompt and audit inputs will be built only from validated database rows; fabricated fallback evidence will be removed.

## Evidence file lifecycle and HTTP behavior

One canonical extension-to-MIME mapping will drive upload validation, parsing support, persistence, and download headers. `.txt` remains supported. Stored records will retain a real MIME type rather than an extension.

Upload will validate relational inputs before saving bytes, remove newly stored bytes if parsing or database persistence fails, and preserve the original error. Deletion will remove the database record and then the file; failed file cleanup will be surfaced and audited so sensitive orphaned evidence is not silently retained.

## Tests and verification

Regression tests will be written before implementation for:

- complete ID matching and confirmed-only combined-report inputs;
- removal of fabricated prompt evidence;
- study/document scoping on reads and mutations;
- `.txt` upload support and MIME download headers;
- cleanup after upload failure and deletion;
- atomic confirmation behavior and uniqueness conflicts;
- migration presence of tables, constraints, indexes, and RLS policies.

After implementation, run Prisma formatting/validation/generation, targeted tests, the broader affected suite, lint, typecheck, build, and migration safety checks available in the repository. Remove `diag.txt`. Do not modify unrelated user files and do not push without explicit authorization.
