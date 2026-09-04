/**
 * Injection token for the embedding provider.
 *
 * An interface cannot be a Nest provider token, and the whole point of the
 * EmbeddingProvider seam is that the concrete class is swappable — Q10 may yet
 * name a different one. Injecting by token means that swap is a single line in
 * the module, with no consumer changing at all.
 */
export const EMBEDDING_PROVIDER = Symbol("EMBEDDING_PROVIDER");
