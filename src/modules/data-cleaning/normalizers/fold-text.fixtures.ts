// RIO-FR-002 — the shared contract between foldText() and rio_fold_text().
//
// Both the vitest spec (fold-text.spec.ts) and the database parity check
// (scripts/check-fold-parity.ts) assert against THIS list, so the two
// implementations cannot drift apart without a test going red.
//
// Add a case here whenever a new class of input turns up in real field data.

export interface FoldFixture {
  label: string;
  input: string;
  expected: string;
}

export const FOLD_FIXTURES: FoldFixture[] = [
  // ── Arabic spelling variance: the whole reason this function exists ──
  { label: "ta marbuta vs heh", input: "المخواة", expected: "المخواه" },
  { label: "ta marbuta already heh", input: "المخواه", expected: "المخواه" },
  { label: "hamza on alef", input: "الأحساء", expected: "الاحساء" },
  { label: "hamza below alef", input: "الإحساء", expected: "الاحساء" },
  { label: "madda alef", input: "آل سعود", expected: "ال سعود" },
  { label: "wasla alef", input: "ٱلرياض", expected: "الرياض" },
  { label: "alef maqsura", input: "ليلى", expected: "ليلي" },
  { label: "hamza on waw", input: "مؤسسة", expected: "موسسه" },
  { label: "hamza on yeh", input: "بئر", expected: "بير" },
  { label: "tashkeel stripped", input: "الاحسَاء", expected: "الاحساء" },
  { label: "shadda and sukun", input: "المكّرْمة", expected: "المكرمه" },
  { label: "tatweel stripped", input: "الريـــاض", expected: "الرياض" },

  // ── Digits ──
  { label: "arabic-indic digits", input: "مركز ١٠", expected: "مركز 10" },
  { label: "ascii digits kept", input: "مركز 10", expected: "مركز 10" },

  // ── Punctuation, Arabic and Latin ──
  { label: "arabic comma", input: "صحي، تعليم", expected: "صحي تعليم" },
  { label: "arabic question mark", input: "أين؟", expected: "اين" },
  { label: "arabic semicolon", input: "أ؛ب", expected: "ا ب" },
  { label: "arabic percent sign", input: "٪ ٥٠", expected: "50" },
  { label: "arabic full stop", input: "أ۔ب", expected: "ا ب" },
  { label: "ascii punctuation", input: "a!\"#$%&()*+,-./:;<=>?@[]^_`{|}~b", expected: "a b" },
  { label: "em dash", input: "a—b", expected: "a b" },
  { label: "curly quotes", input: "a‘b’c”d", expected: "a b c d" },
  { label: "currency and math symbols", input: "a×b÷c€d", expected: "a b c d" },

  // ── Invisible characters: the ones that break equality silently ──
  { label: "zero-width space", input: "a​b", expected: "a b" },
  { label: "right-to-left mark", input: "‏الرياض‏", expected: "الرياض" },
  { label: "non-breaking space", input: "a b", expected: "a b" },

  // ── Whitespace ──
  { label: "tabs and newlines", input: "a\tb\nc", expected: "a b c" },
  { label: "collapsed and trimmed", input: "   spaced   out   ", expected: "spaced out" },

  // ── Latin ──
  { label: "ascii case folded", input: "Al-Baha Region", expected: "al baha region" },
  { label: "latin accents to base", input: "Café", expected: "cafe" },
  { label: "turkish dotted I", input: "İIıi", expected: "i i" },

  // ── Degenerate input ──
  { label: "empty string", input: "", expected: "" },
  { label: "punctuation only", input: "!!! ???", expected: "" },
  { label: "whitespace only", input: "   ", expected: "" },

  // ── Realistic need statements ──
  {
    label: "need statement with punctuation",
    input: "نقص المياه الصالحة للشرب في القرية، خاصة في الصيف.",
    expected: "نقص المياه الصالحه للشرب في القريه خاصه في الصيف",
  },
  {
    label: "same statement, different orthography",
    input: "نقص المياه الصالحه للشرب في القريه خاصه في الصيف",
    expected: "نقص المياه الصالحه للشرب في القريه خاصه في الصيف",
  },
];
