import { ReadError } from "@/lib/query/read";

/**
 * THE PARSE BOUNDARY, SHARED BY EVERY FETCHER.
 *
 * ⚠️ IT LIVED AT THE FOOT OF `fetchers/task.ts` UNTIL P12-07, and it moved here
 * for one reason: the list and the board needed the same two functions, and the
 * alternative was a second copy. A second copy of a parse boundary is two places
 * that can start reporting a shape fault differently — which is precisely the
 * thing this pair exists to stop each fetcher from doing on its own.
 *
 * Nothing about it changed on the way. The comments below are the ones written
 * for the detail page and they still say what they said.
 */

/**
 * ⚠️ ONE PLACE THE PARSE FAILURE IS TURNED INTO A SENTENCE, so every fetcher
 * reports a shape mismatch the same way and none of them is tempted to
 * cast instead.
 *
 * NO POSTGREST CODE IS INVENTED FOR IT — `snapshot.ts` argues this at length.
 * `isPermanent()` keys on the `42xxx` family because those are genuinely
 * "permission denied for table …"; borrowing one to buy a skipped retry would
 * make the retry policy lie about what happened. So a shape fault retries twice
 * like any other transient failure and then lands in `isError`, where it
 * belongs.
 */
export function parse<T>(schema: { safeParse: (value: unknown) => SafeParse<T> }, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new ReadError(
    `${what} came back in a shape this build does not recognise. If a migration has ` +
      `not been applied to this project yet, that is why.`,
    undefined,
    parsed.error.message,
  );
}

export function parseAll<T>(
  schema: { safeParse: (value: unknown) => SafeParse<T> },
  rows: unknown,
  what: string,
): T[] {
  if (!Array.isArray(rows)) {
    throw new ReadError(`${what} came back as something other than a list of rows.`);
  }
  return rows.map((row) => parse(schema, row, what));
}

/** The half of zod's result these two helpers actually read. */
export type SafeParse<T> =
  | { success: true; data: T }
  | { success: false; error: { message: string } };
