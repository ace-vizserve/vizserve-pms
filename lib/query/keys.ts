/**
 * Query keys. The hierarchy IS the invalidation API: `invalidateQueries` matches
 * by prefix, so every key is built here and nowhere else.
 */

/**
 * Drops `undefined` and `""` so `?q=` and no `q` at all are one cache entry.
 * Without it, clearing a search box would miss the entry it came from.
 */
export function normalize<T extends Record<string, unknown>>(params: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    out[key as keyof T] = value as T[keyof T];
  }
  return out;
}

export const qk = {
  /** P12-01. The rail: badges, the project tree and its counts, personal lists. */
  snapshot: () => ["sidebar", "snapshot"] as const,

  /** P12-17. The unread count beside the inbox filters — the WHOLE inbox. */
  unread: () => ["notifications", "unread"] as const,
  /** P12-17. One page of the inbox, per filter combination. */
  inbox: (filters: Record<string, string | undefined>) => ["inbox", normalize(filters)] as const,
} as const;
