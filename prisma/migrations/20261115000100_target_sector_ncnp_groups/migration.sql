-- GEN-07 (UAT v1.4, client update 15 Nov) — the Target Sector / Subject list
-- becomes the 10 Groups (Level 1) of the NCNP Non-Profit Entity
-- Classification. Only the list changes: the field stays a single dropdown and
-- System Admins keep editing it under Methodology → Config.
--
-- The 6 earlier options are switched off, not deleted, because studies and
-- historical studies store the option name as plain text; those records keep
-- showing the value they were saved with. "Health" is one of the new Groups, so
-- the upsert below reactivates it with its Arabic name and new position.

UPDATE "target_sector_options"
   SET "is_active" = false, "updated_at" = now()
 WHERE "name" IN (
   'Health',
   'Education',
   'WASH (Water, Sanitation & Hygiene)',
   'Livelihoods',
   'Protection',
   'Multi-Sector'
 );

INSERT INTO "target_sector_options" ("id", "name", "name_ar", "display_order", "is_active", "updated_at") VALUES
  (uuidv7(), 'Culture & Recreation', 'الثقافة والترفيه', 1, true, now()),
  (uuidv7(), 'Education & Research', 'التعليم والأبحاث', 2, true, now()),
  (uuidv7(), 'Health', 'الصحة', 3, true, now()),
  (uuidv7(), 'Social Services', 'الخدمات الاجتماعية', 4, true, now()),
  (uuidv7(), 'Environment', 'البيئة', 5, true, now()),
  (uuidv7(), 'Development & Housing', 'التنمية والإسكان', 6, true, now()),
  (uuidv7(), 'Advocacy & Rights', 'التأييد والمؤازرة', 7, true, now()),
  (uuidv7(), 'Philanthropy & Volunteering Support', 'منظمات دعم العمل الخيري', 8, true, now()),
  (uuidv7(), 'Religious Guidance, Education & Pilgrim Services', 'منظمات الدعوة والإرشاد والتعليم الديني وخدمة ضيوف الرحمن', 9, true, now()),
  (uuidv7(), 'Professional Associations', 'الروابط المهنية', 10, true, now())
ON CONFLICT ("name") DO UPDATE
   SET "name_ar" = EXCLUDED."name_ar",
       "display_order" = EXCLUDED."display_order",
       "is_active" = true,
       "updated_at" = now();
