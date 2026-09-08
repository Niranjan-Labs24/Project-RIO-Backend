-- RIO-FR-002 — make rio_fold_text LOCALE-INDEPENDENT.
--
-- The first cut (20260902000000_fr002_data_cleaning) used lower() and
-- '[[:punct:]]' . Both are resolved against the database's ctype/collation,
-- and probing the live database showed the consequences:
--
--   * '[[:punct:]]' removed × and ÷ but NOT €, so which characters survive
--     folding depended on a table nobody on this project controls.
--   * Zero-width characters were left in place entirely — U+200B (ZWSP) and
--     U+200F (RLM) both survived. Arabic pasted out of Word or a browser
--     routinely carries RLM, so two spellings of the same village could fold
--     to different strings for a reason invisible on screen.
--   * lower() lowercases İ (U+0130) differently from JavaScript's
--     toLowerCase(), which decomposes it to i + U+0307. The TypeScript
--     normalizer has to agree with this function BYTE FOR BYTE, and a
--     Unicode-aware lower() in two runtimes is not a promise anyone can keep.
--
-- That matters more here than it usually would, because four functional GIN
-- indexes are built over this function's output. If the collation ever
-- changes underneath a locale-dependent definition, the indexes silently stop
-- agreeing with the function and duplicate detection quietly misses pairs —
-- with no error anywhere.
--
-- This version uses only translate() and explicit code-point ranges, so the
-- result depends on nothing but the input. It is a strict improvement, not a
-- behaviour change anyone has come to rely on: FR-002 has no application code
-- yet and no rows have been folded in anger.
--
-- What changed, precisely:
--   * ASCII case folding via translate(A-Z -> a-z) instead of lower(), so
--     non-ASCII case rules can never diverge between Postgres and Node.
--   * Latin-1 accented letters transliterate to their base letter, so "Café"
--     and "Cafe" fold alike rather than to 'caf' and 'cafe'.
--   * The keep-set is now explicit — ASCII alphanumerics plus the Arabic
--     LETTER ranges (U+0621..U+064A hamza..yeh, U+0671..U+06D3 extended).
--     Everything else, including Arabic punctuation (، ؛ ؟ ٪ ۔), the
--     zero-width marks and every currency or math symbol, collapses to a
--     space. Arabic-Indic digits and diacritics are handled by the translate
--     steps before this one, so they never reach it.
--
-- REINDEX at the end is mandatory: the stored index entries were built from
-- the old definition and are wrong for the new one.

CREATE OR REPLACE FUNCTION rio_fold_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        translate(
          translate(
            translate(
              translate(input, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
              'àáâãäåèéêëìíîïòóôõöùúûüçñýÿÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÇÑÝ',
              'aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny'
            ),
            -- Tashkeel (fatha, damma, kasra, shadda, sukun, tanween, dagger
            -- alef) and tatweel. translate() with an empty `to` deletes them.
            'ًٌٍَُِّْٰـ', ''
          ),
          -- Alef forms -> ا, alef maqsura -> ي, ta marbuta -> ه, hamza
          -- carriers -> و/ي, Arabic-Indic digits -> ASCII.
          'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩',
          'اااايهوي0123456789'
        ),
        -- Explicit keep-set. The two Arabic ranges are LETTERS only: the
        -- block's punctuation (U+060C ، U+061B ؛ U+061F ؟ U+066A ٪ U+06D4 ۔)
        -- sits outside them and is dropped here, which is what we want.
        '[^a-z0-9ء-يٱ-ۓ]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION rio_fold_text(text) IS
  'RIO-FR-002. Locale-independent orthographic folding for Arabic/English comparison. Byte-identical to foldText() in src/modules/data-cleaning/normalizers/fold-text.ts — the pair is pinned by a shared fixture (fold-text.fixtures.ts) that both a vitest spec and scripts/check-fold-parity.ts assert against. Changing either side requires changing both AND reindexing every functional index over it.';

-- The four functional indexes store the OLD folded values. Rebuild them.
REINDEX INDEX "needs_title_folded_trgm_idx";
REINDEX INDEX "needs_statement_folded_trgm_idx";
REINDEX INDEX "centers_name_folded_trgm_idx";
REINDEX INDEX "governorates_name_folded_trgm_idx";
