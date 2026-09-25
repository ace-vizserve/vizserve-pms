/**
 * The read path. Every `queryFn` in the app goes through this.
 *
 * ⚠️ A FAILED READ THROWS. IT NEVER FALLS BACK TO AN EMPTY ARRAY. That single
 * rule is why this file exists, and this codebase has paid for it twice:
 *
 *   1. `sidebar-panel.tsx` ends every read in `?? []`, so a failed query and a
 *      genuinely empty result render identically. A burst of concurrent requests
 *      failing with `TypeError: fetch failed` emptied the project tree and zeroed
 *      every count in the rail, silently, with no error anywhere on screen.
 *   2. `mineFilter` once built an `or(...)` holding every assigned task id — a
 *      16,542-character URL that `fetch` refused with no status and no PostgREST
 *      message. Every caller did `data ?? []`, so it rendered as "you have no
 *      open tasks" to somebody holding 22. See `tests/unit/task-filters.test.ts`,
 *      which guards the filter half of that bug; this guards the reporting half.
 *
 * Both bugs are the same bug: a failure that was indistinguishable from a legal
 * empty result. Throwing puts it in `isError`, where a component can say
 * "couldn't load" instead of lying with a zero.
 */
import type { PostgrestError } from "@supabase/supabase-js";

import { readableError } from "@/lib/action-result";

/**
 * A read that did not come back.
 *
 * `code` is PostgREST's, kept because the retry policy needs it: `42501` and the
 * rest of the `42xxx` family are `permission denied for table …`, which per
 * CLAUDE.md is ALWAYS a missing GRANT and never transient. Retrying one three
 * times triples the log noise and fixes nothing.
 */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "ReadError";
  }
}

/**
 * A PostgREST builder is a THENABLE, not a promise — `.then()` is what fires the
 * request. Typed loosely enough to accept a builder, an `.rpc()` call or a hand
 * -rolled `{ data, error }`, which is what makes a fetcher testable without a
 * Supabase client.
 */
type Result<T> = PromiseLike<{ data: T | null; error: PostgrestError | null }>;

/**
 * Runs one read and returns its rows, or throws.
 *
 * `readableError` is reused rather than reimplemented, so a policy refusal or a
 * constraint message reads as the same sentence whether it surfaced from a read
 * here or from a Server Action — the rules in this app live in the database and
 * raise text written for a person.
 */
export async function read<T>(query: Result<T>): Promise<T> {
  const { data, error } = await query;

  if (error) {
    throw new ReadError(readableError(error), error.code, error.details ?? undefined);
  }

  // `null` with no error is a legal single-row miss (`.maybeSingle()`), and the
  // caller's type says whether that is expected. Not coerced to `[]` here — see
  // the whole point of this file.
  return data as T;
}

/**
 * Counts come back on their own channel: `head: true` ships no rows, so `data`
 * is null on success and `?? 0` would be indistinguishable from a failure again.
 */
export async function readCount(
  query: PromiseLike<{ count: number | null; error: PostgrestError | null }>,
): Promise<number> {
  const { count, error } = await query;

  if (error) {
    throw new ReadError(readableError(error), error.code, error.details ?? undefined);
  }

  return count ?? 0;
}

/** True for the failures that will never succeed on a retry. */
export function isPermanent(error: unknown): boolean {
  return error instanceof ReadError && (error.code?.startsWith("42") ?? false);
}
