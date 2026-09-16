-- Fixes a real bug found via end-to-end verification: TranslationService's
-- cache write is `prisma.translationCache.upsert()`, which Postgres compiles
-- to `INSERT ... ON CONFLICT DO UPDATE` — the UPDATE clause needs UPDATE
-- privilege on the table even on the (overwhelmingly common) insert-only
-- path, which the original migration
-- (20260908110000_translation_cache) never granted. Every translation
-- request was paying for the real AI call and then failing outright on this
-- write with `permission denied for table translation_cache`, which
-- TranslationService does not catch (only the AI-call try/catch does) — so
-- the request 500'd and the frontend's best-effort fallback silently kept
-- showing the original (untranslated) text. This is why user-typed content
-- (initiative names, etc.) never actually appeared translated end-to-end
-- despite the feature being wired up correctly everywhere else.

GRANT UPDATE ON "translation_cache" TO cnap_app;
