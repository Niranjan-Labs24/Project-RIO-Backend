-- Root cause of a real reported bug: an AI-classification override to a
-- subdomain like "Access to Basic Education" (Education) produced zero
-- suggested questions, even though the domain/subdomain was a normal,
-- selectable option in the Override dialog. Investigated end-to-end: the
-- Override dialog's domain/subdomain options come from the sub_domains
-- reference table, which is entirely independent of the questions table —
-- so a subdomain can sit there, active and selectable, with no actual
-- questions behind it in the current PUBLISHED methodology version.
--
-- Root cause: the original taxonomy import (2026-08-05, alongside the
-- legacy v1.0 question bank) used slightly different subdomain wording than
-- the v5.0 re-import on 2026-08-17 (e.g. "Access to Basic Education" vs.
-- "Basic Education Access", "Communications & Digital Connectivity" vs.
-- "Digital Connectivity"). Both rows were left active, so reviewers can
-- still pick the orphaned 2026-08-05 wording and get an empty question set.
--
-- Fix: deactivate every currently-active subdomain that has zero questions
-- under the currently PUBLISHED methodology version. This is the same
-- selectability toggle DomainsService already uses elsewhere (SubDomain.
-- isActive) — it only removes these from future dropdown options, it does
-- not touch any existing Need/NeedDomain/Question row (Need.domain/
-- subDomain are plain strings, not foreign keys, so nothing already
-- classified is affected). If the currently-published methodology version
-- ever changes, or a subdomain is intentionally added ahead of its
-- questions, this condition should be re-checked before assuming it's safe
-- to re-run — it is written as a one-time, one-shot cleanup, not a
-- recurring rule.
UPDATE "sub_domains" sd
SET "is_active" = false
WHERE sd."is_active" = true
  AND NOT EXISTS (
    SELECT 1 FROM "questions" q
    JOIN "methodology_versions" mv ON mv."id" = q."methodology_version_id"
    WHERE q."sub_domain" = sd."name" AND mv."status" = 'PUBLISHED'
  );
