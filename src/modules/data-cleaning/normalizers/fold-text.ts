// RIO-FR-002 — orthographic folding, the foundation every comparison in this
// module stands on.
//
// Village names, need titles and need statements are all free text, and the
// same village is routinely spelled several ways (the client said as much in
// Q2, about the coordinate file). Comparing raw strings finds almost nothing.
// Every comparison here therefore runs on the FOLDED form.
//
// ─── This function has a twin ───────────────────────────────────────────────
// rio_fold_text(text) in the database is the same function, and four
// functional GIN/trigram indexes are built over ITS output. If the two ever
// disagree, this module proposes matches the indexes cannot find and duplicate
// detection quietly misses pairs — with no error anywhere to notice.
//
// They are kept in step three ways:
//   1. Neither uses a locale-dependent primitive. No toLowerCase() on
//      non-ASCII, no \p{...}, no [[:punct:]], no [[:alnum:]] — those resolve
//      against a collation on one side and an ECMAScript engine on the other,
//      and the two are not the same table. (The first cut of the SQL used
//      lower() and [[:punct:]]; probing the live database showed it dropped ×
//      and ÷ but kept €, and left U+200B/U+200F untouched. See migration
//      20260902010000_fr002_deterministic_fold.)
//   2. FOLD_FIXTURES below is asserted by fold-text.spec.ts here, and by
//      scripts/check-fold-parity.ts against the real database.
//   3. Changing either side means changing both AND reindexing.

// ASCII case folding only. JavaScript's toLowerCase() decomposes İ (U+0130)
// to i + U+0307 and Postgres's lower() does not; Arabic has no case, and no
// other script in this data does either.
const ASCII_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";

// Latin-1 accented letters to their base letter, so "Café" and "Cafe" fold
// alike. Without this the keep-set below would delete the accented character
// outright and leave 'caf', which compares worse than either spelling.
const LATIN_ACCENTS =
  "àáâãäåèéêëìíîïòóôõöùúûüçñýÿÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÇÑÝ";
const LATIN_BASE =
  "aaaaaaeeeeiiiiooooouuuucnyyaaaaaaeeeeiiiiooooouuuucny";

// Tashkeel — fatha, damma, kasra, shadda, sukun, the three tanween marks and
// the dagger alef — plus tatweel (U+0640), the decorative letter-stretching
// character. All are presentational and never distinguish one village from
// another. Deleted (empty replacement).
const TASHKEEL =
  "ًٌٍَُِّْٰـ";

// The spelling variances that actually matter in Saudi place and need text:
// the four alef forms collapse to bare alef, alef maqsura to yeh, ta marbuta
// to heh, the two hamza carriers to their base letter, and Arabic-Indic
// digits to ASCII so "مركز ١٠" and "مركز 10" compare equal.
const ARABIC_VARIANTS = "أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩";
const ARABIC_CANONICAL = "اااايهوي0123456789";

// Explicit keep-set: ASCII alphanumerics and the Arabic LETTER ranges
// (U+0621..U+064A hamza..yeh, U+0671..U+06D3 extended letters). Everything
// else becomes a space — including Arabic punctuation (، ؛ ؟ ٪ ۔), which sits
// outside those ranges, and the zero-width marks (U+200B ZWSP, U+200F RLM)
// that Arabic pasted out of Word carries invisibly.
const NON_KEEPABLE = /[^a-z0-9ء-يٱ-ۓ]+/g;

/**
 * Postgres translate() semantics: map each character in `from` to the
 * character at the same index in `to`, and DELETE it when `to` is shorter.
 * Duplicate characters in `from` take their first mapping, as Postgres does.
 */
function translate(input: string, from: string, to: string): string {
  const map = new Map<string, string>();
  for (let i = 0; i < from.length; i++) {
    const ch = from[i]!;
    if (map.has(ch)) continue;
    map.set(ch, i < to.length ? to[i]! : "");
  }
  let out = "";
  for (const ch of input) {
    const mapped = map.get(ch);
    out += mapped === undefined ? ch : mapped;
  }
  return out;
}

/**
 * Fold text for comparison. Byte-identical to rio_fold_text() in the database.
 *
 * The output is a comparison key, never something to display or store: it has
 * lost case, diacritics and punctuation on purpose.
 */
export function foldText(input: string): string {
  const cased = translate(input, ASCII_UPPER, ASCII_LOWER);
  const deaccented = translate(cased, LATIN_ACCENTS, LATIN_BASE);
  const bare = translate(deaccented, TASHKEEL, "");
  const canonical = translate(bare, ARABIC_VARIANTS, ARABIC_CANONICAL);
  return canonical.replace(NON_KEEPABLE, " ").replace(/\s+/g, " ").trim();
}

/** True when two strings are the same once folded. */
export function foldsEqual(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
}

// ─── Trigram similarity ─────────────────────────────────────────────────────

/**
 * pg_trgm-compatible trigrams: each word is padded with two leading spaces
 * and one trailing space, then cut into 3-character windows.
 *
 * Deliberately mirrors pg_trgm rather than inventing a scheme, because the
 * database-side candidate query uses similarity() over the same folded text.
 * A different definition here would rank candidates differently from the query
 * that produced them, which reads to a reviewer as the system contradicting
 * itself.
 */
export function trigrams(folded: string): Set<string> {
  const out = new Set<string>();
  for (const word of folded.split(" ")) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      out.add(padded.slice(i, i + 3));
    }
  }
  return out;
}

/**
 * Jaccard similarity over trigram sets, 0..1 — the same measure pg_trgm's
 * similarity() reports.
 *
 * Two empty strings score 0, not 1: "these two blank fields match" is never a
 * useful thing to tell a reviewer, and scoring it 1 would put every pair of
 * empty needs at the top of the duplicate queue.
 */
export function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}
