/**
 * Query keys. The hierarchy IS the invalidation API: `invalidateQueries` matches
 * by prefix, so every key is built here and nowhere else.
 */
export const qk = {
  /** P12-01. The rail: badges, the project tree and its counts, personal lists. */
  snapshot: () => ["sidebar", "snapshot"] as const,
} as const;
