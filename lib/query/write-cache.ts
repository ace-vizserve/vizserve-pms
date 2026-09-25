import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { markLocalWrite } from "./local-write";

/**
 * SNAPSHOT, CANCEL, ROLL BACK — the three moves every optimistic write makes,
 * with the key roots as a parameter.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS IS `lib/query/task-cache.ts`'S OPENING, EXTRACTED IN P12-16, NOT A
 * SECOND COPY OF IT. That file delegates to these three and keeps everything
 * that is genuinely about a TASK: the roots, `patchTaskRow`, the placeholder
 * rows, the per-panel edits. Phase 4 added four more domains that need exactly
 * this bookkeeping over different roots, and the alternative was five copies of
 * a rollback — which is the one thing in the optimistic path that is SILENT when
 * it is wrong. `parse.ts` was extracted from `fetchers/task.ts` for the same
 * reason and says so at greater length.
 *
 * ⚠️ THE COMMENTS BELOW ARE THE ONES WRITTEN FOR THE TASK PATH AND THEY STILL
 * SAY WHAT THEY SAID. Both hard-won orderings are properties of TanStack and of
 * this app's realtime plumbing, not of tasks, so they travel with the code.
 * ------------------------------------------------------------------------
 */

/** Every `[key, data]` pair under the roots, as it stood before the write. */
export type CacheSnapshot = readonly (readonly [QueryKey, unknown])[];

/**
 * Stop the refetches that would overwrite the paint, then remember what was
 * there.
 *
 * ⚠️ SYNCHRONOUS, AND `cancelQueries` IS DELIBERATELY NOT AWAITED HERE.
 *
 * The task version used to open with
 * `await Promise.all(roots.map(k => client.cancelQueries(k)))`, which is what
 * TanStack's guide shows — and it put the visible update BEHIND A NETWORK
 * CANCELLATION. Something is almost always in flight (the rail RPC alone takes
 * ~1.3s), so the click waited on that before the cache was touched at all.
 * Ace's report was exact: "why is state update taking so long? not instant?"
 *
 * The cancellation is still needed — it stops an in-flight refetch landing after
 * the patch and overwriting it — but it does NOT have to happen before the
 * patch. It only has to happen before that refetch resolves. So the snapshot and
 * the patch are synchronous, and `cancelRefetches` below is fired immediately
 * after by the caller.
 *
 * ⚠️ `markLocalWrite()` IS CALLED HERE BECAUSE EVERY OPTIMISTIC WRITE STARTS
 * HERE. The realtime ping this write is about to produce is our own echo, and
 * re-fetching what `onSettled` has already asked for doubled every mutation.
 * See `lib/query/local-write.ts`.
 */
export function beginWrite(client: QueryClient, roots: readonly QueryKey[]): CacheSnapshot {
  markLocalWrite();
  return roots.flatMap((queryKey) => client.getQueriesData({ queryKey }));
}

/**
 * Stop an in-flight refetch landing on top of a patch that has already been
 * applied.
 *
 * ⚠️ FIRED, NEVER AWAITED, AND CALLED AFTER THE PATCH. Awaiting it is what made
 * the click feel slow; see `beginWrite`. The race it closes is a refetch that
 * STARTED before the patch and RESOLVES after it — and that resolution is
 * milliseconds away at best, so firing this in the same tick is early enough.
 */
export function cancelRefetches(client: QueryClient, roots: readonly QueryKey[]): void {
  for (const queryKey of roots) void client.cancelQueries({ queryKey });
}

/**
 * Put every entry back exactly as it was.
 *
 * ⚠️ THIS IS THE WHOLE OF `onError`, AND LEAVING IT OUT IS SILENT. A refused
 * write with no rollback leaves the browser showing a value the database
 * refused, with a toast that scrolls away — the inline editors' own rule
 * (`inline.tsx`) says a refusal must PUT THE OLD VALUE BACK, because an editor
 * holding the new one is lying about the state of the database.
 *
 * ⚠️ AND `useOptimistic` USED TO DO THIS FOR FREE. Every control converted in
 * Phases 3 and 4 gave up a React-owned rollback for a cache that keeps its value
 * until something replaces it — which is the whole reason the value survives
 * long enough to be useful, and the whole reason this function is not optional.
 */
export function rollbackWrite(client: QueryClient, snapshot: CacheSnapshot): void {
  for (const [queryKey, data] of snapshot) client.setQueryData(queryKey, data);
}
