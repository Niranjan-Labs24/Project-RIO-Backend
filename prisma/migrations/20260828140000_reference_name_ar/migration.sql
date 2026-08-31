-- RIO-I18N-003 §6 (rows 6 and 8) — the client's Arabic wording for the
-- methodology and geography vocabulary.
--
-- These are the last source of English in an otherwise-Arabic report: a domain
-- called "Education", a governorate called "Al-Bada'", a centre name. Every
-- other layer is now translated — narrative, chrome, bands, confidence reasons
-- — and these names remained because they are NOT ours to translate. They are
-- NCNP's authoritative terminology, and a report that invents them is worse
-- than one that leaves them in English.
--
-- A SEPARATE COLUMN rather than a translation applied anywhere in code. `name`
-- stays the canonical key that the scoring engine, the AI prompts' verbatim
-- rules and every stored report content blob already agree on; only the render
-- layer substitutes `name_ar`. That separation is what makes translating a
-- label incapable of changing which record a figure belongs to.
--
-- Nullable, with no backfill. Null is the expected state until the vocabulary
-- arrives, and an Arabic report falls back to the English `name` for anything
-- still missing — visibly incomplete rather than silently wrong. Defaulting
-- these to a machine translation would produce a report that looks finished and
-- cites terms NCNP never approved.

ALTER TABLE "domains"      ADD COLUMN "name_ar" VARCHAR(200);
ALTER TABLE "sub_domains"  ADD COLUMN "name_ar" VARCHAR(200);
ALTER TABLE "regions"      ADD COLUMN "name_ar" VARCHAR(150);
ALTER TABLE "governorates" ADD COLUMN "name_ar" VARCHAR(150);
ALTER TABLE "centers"      ADD COLUMN "name_ar" VARCHAR(150);
