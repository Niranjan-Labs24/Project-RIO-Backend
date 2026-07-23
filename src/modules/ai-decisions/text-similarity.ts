// Deterministic, dependency-free text similarity for the classification
// fallback chain's "reuse a similar prior Need" tier (see
// AiDecisionsService.classifyFromPriorNeeds). Deliberately isolated in its
// own module — a later swap to embeddings/cosine similarity or a real NLP
// library only ever touches this file, never the fallback orchestration
// that calls it.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'do', 'does', 'did',
  'have', 'has', 'had', 'not', 'no', 'we', 'they', 'their', 'our', 'i', 'you',
]);

/** Lowercase, strip punctuation, split on whitespace, drop stopwords and
 * single-character tokens — keeps only the words likely to carry meaning
 * (place names, symptoms, infrastructure terms, etc.). */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Jaccard similarity (|intersection| / |union|) over normalized token
 * sets — 0 (nothing in common) to 1 (identical token sets). Simple and
 * fully deterministic on purpose: good enough to tell "same issue,
 * different village" apart from "unrelated Need", without needing a model
 * call of its own in the exact path meant to cover for the model being down. */
export function textSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersectionSize += 1;
  }
  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/** Picks the single most similar candidate to `statement`, or null if
 * `candidates` is empty. Ties keep whichever candidate appeared first. */
export function findMostSimilar<T extends { statement: string }>(
  statement: string,
  candidates: T[],
): { candidate: T; score: number } | null {
  let best: { candidate: T; score: number } | null = null;
  for (const candidate of candidates) {
    const score = textSimilarity(statement, candidate.statement);
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}
