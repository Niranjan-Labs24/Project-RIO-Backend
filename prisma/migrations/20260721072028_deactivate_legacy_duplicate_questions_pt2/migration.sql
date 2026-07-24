-- Follow-up to 20260721071548_deactivate_legacy_duplicate_questions: that
-- migration's collision regex ('^(H|ED|WS|LV|SD|GV)[0-9]+$') missed three of
-- the new import's actual prefixes — CU (Culture), EN (Energy &
-- Environment), and IN (Infrastructure) — so their legacy duplicates
-- ("I01"-"I10" vs the real "IN01"-"IN10", "EN01"-"EN10" old vs new) were
-- left active and kept getting picked over the real, scoreable ones
-- (confirmed live: a fresh "Poor Road Connectivity" survey picked legacy
-- "I03" instead of "IN03").
--
-- Full prefix set actually used by the extended Question Bank CSV, verified
-- directly against the file this time: CU, ED, EN, GV, H, IN, LV, SD, WS.
UPDATE "questions"
SET "used_in_mvp" = false
WHERE "question_id" !~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+$'
  AND ("domain", "sub_domain") IN (
    SELECT "domain", "sub_domain" FROM "questions" WHERE "question_id" ~ '^(CU|ED|EN|GV|H|IN|LV|SD|WS)[0-9]+$'
  );