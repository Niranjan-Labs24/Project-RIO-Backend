-- RIO-FR-012 (Q4/Q35) — PLACEHOLDER values only, so the Study Type / Target
-- Sector fields can actually be tested end-to-end in the UI while the
-- client's real value list (Q35 follow-up) is still outstanding. These are
-- not client-confirmed; a System Admin can rename/deactivate them from
-- Methodology Configuration once the real list lands, or this table can be
-- re-seeded directly — no code change needed either way, per the
-- `StudyConfigOption` name being validated at the API layer, not an FK.
INSERT INTO "study_type_options" ("id", "name", "display_order", "updated_at") VALUES
  (uuidv7(), 'Baseline Assessment', 0, now()),
  (uuidv7(), 'Rapid Needs Assessment', 1, now()),
  (uuidv7(), 'Follow-up Assessment', 2, now()),
  (uuidv7(), 'Thematic Study', 3, now())
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "target_sector_options" ("id", "name", "display_order", "updated_at") VALUES
  (uuidv7(), 'Health', 0, now()),
  (uuidv7(), 'Education', 1, now()),
  (uuidv7(), 'WASH (Water, Sanitation & Hygiene)', 2, now()),
  (uuidv7(), 'Livelihoods', 3, now()),
  (uuidv7(), 'Protection', 4, now()),
  (uuidv7(), 'Multi-Sector', 5, now())
ON CONFLICT ("name") DO NOTHING;
