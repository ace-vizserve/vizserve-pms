/**
 * Building `ilike` filters from user input, safely.
 *
 * PostgREST's `.or()` takes a RAW FILTER STRING — `title.ilike.%foo%,body.ilike.%foo%`.
 * Interpolating a search box into that directly is a filter-injection hole:
 *
 *   "a,b"   splits the expression into three filters, one of them malformed
 *   "a)b"   closes the or() group early
 *   "50%"   silently becomes a wildcard and matches everything
 *
 * The first two produce a 400 the user reads as "search is broken"; the third
 * produces confidently wrong results, which is worse. Both are fixed by
 * escaping in two distinct layers, in this order:
 *
 *   1. LIKE metacharacters, so the pattern matches what was typed
 *   2. PostgREST's quoted-value syntax, so the filter string stays one filter
 *
 * The order matters. Escaping for PostgREST first would then escape the
 * backslashes added by step 1, and a literal `%` would arrive at Postgres still
 * acting as a wildcard.
 */

/** Cap on a search term. Long enough for a reference number and a few words. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * Escapes LIKE metacharacters, then wraps in wildcards for a contains match.
 *
 * `\` must be replaced first or it would double the backslashes this very
 * function adds for `%` and `_`. A single regex over all three avoids that
 * ordering trap entirely.
 */
export function likeContains(raw: string): string {
  const escaped = raw.replace(/[\\%_]/g, (character) => `\\${character}`);
  return `%${escaped}%`;
}

/**
 * Wraps a value in PostgREST's double-quoted form so commas, parentheses and
 * dots inside it are data rather than syntax.
 */
export function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * A complete `or=` expression matching `term` against every named column.
 *
 * Returns null for an empty or whitespace-only term, so a caller can skip the
 * filter entirely rather than applying `%%` — which matches everything and
 * costs a full scan to do it.
 */
export function ilikeAnyOf(columns: string[], term: string | null | undefined): string | null {
  const trimmed = (term ?? "").trim().slice(0, MAX_SEARCH_LENGTH);
  if (!trimmed) return null;

  const value = quoteFilterValue(likeContains(trimmed));
  return columns.map((column) => `${column}.ilike.${value}`).join(",");
}
