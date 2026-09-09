/**
 * P8-03, rewritten for the cache: which keys a table event makes stale.
 *
 * ⚠️ THE PAYLOAD IS STILL NEVER READ, and that rule survives this change intact.
 * `use-realtime-refresh.ts` argues it at length: patching rows out of a
 * postgres_changes payload creates a second source of truth that drifts from the
 * database the first time a policy, a trigger or a derived column disagrees with
 * the row on the wire — and the drift is invisible, because the screen looks
 * right. An event says "something you can see has changed"; the data still comes
 * back through a query, under RLS, shaped the way every other read is shaped.
 *
 * What changes is only the reaction. `router.refresh()` re-rendered the entire
 * route — every page in the product paid for one notification arriving — and is
 * now an invalidation of the keys that event can actually have touched.
 *
 * ⚠️ THE RAIL IS ON MOST OF THESE LISTS. Its snapshot carries the open-task
 * count, the pending-request count and both nav badges, so a task, a list, a
 * request or a notification all move it. Leaving `snapshot()` off one of these
 * rows is exactly how the sidebar goes stale again.
 */
import type { QueryKey } from "@tanstack/react-query";

import { qk } from "./keys";

/*
 * ⚠️ `satisfies`, NOT `: Record<string, …>`, AND THE DIFFERENCE IS THE WHOLE
 * SAFETY NET FOR THIS FILE.
 *
 * An annotation would widen the keys to `string`, and `RealtimeTable` below
 * would then be `string` — which is how a subscription on a table nobody mapped
 * becomes a SILENT NO-OP. Under `router.refresh()` an unmapped table still
 * worked, because the refresh re-rendered everything regardless of which table
 * had moved; under invalidation it moves nothing at all, and nothing on screen
 * or in the console says so. `satisfies` keeps the keys literal, so the union is
 * the real list and `useRealtimeRefresh` refuses an unmapped table AT COMPILE
 * TIME. Adding a subscription now forces you to add the row here.
 */
export const INVALIDATES = {
  vizserve_pms_tasks: [qk.tasks(), qk.snapshot()],
  /*
   * ⚠️ BOTH ROOTS, AND THE SINGULAR ONE IS THE EASY MISS. A comment lives at
   * `["task", id, "comments"]` and `qk.tasks()` is `["tasks"]` — a DIFFERENT
   * root, which cannot prefix-match it however long you stare at the pair. On
   * its own that row would refetch every task LIST and never the thread the
   * comment appeared in.
   *
   * `["tasks"]` is still here because the list is not innocent: the row carries
   * a latest-comment column (`latest-comment-cell.tsx`) and its assignee
   * monograms, so both tables move the list as well as the detail.
   */
  vizserve_pms_task_comments: [["task"], qk.tasks()],
  vizserve_pms_task_assignees: [["task"], qk.tasks()],
  vizserve_pms_lists: [["lists"], qk.snapshot()],
  vizserve_pms_task_groups: [["lists"], qk.snapshot()],
  vizserve_pms_requests: [["requests"], qk.snapshot()],
  /*
   * ⚠️ `qk.snapshot()` IS NOT OPTIONAL HERE, and leaving it off is exactly the
   * mistake this file's header warns about. Since P12-01 the unread badge is a
   * field INSIDE the rail snapshot — `qk.unread()` is kept for the day the
   * badge gets its own query again, but today nothing reads it, so a
   * notification arriving would have moved nothing at all.
   */
  vizserve_pms_notifications: [qk.snapshot(), qk.unread(), ["inbox"]],
} satisfies Record<string, readonly QueryKey[]>;

/**
 * Every table a subscription is allowed to name.
 *
 * ⚠️ THIS UNION IS THE LOUD VERSION OF THE GAP. `useRealtimeRefresh` takes this
 * type rather than `string`, so watching a table with no row above is a
 * typecheck failure in `npm run verify` instead of a channel that opens, joins,
 * receives events and invalidates nothing.
 */
export type RealtimeTable = keyof typeof INVALIDATES;

/**
 * The keys one table event invalidates.
 *
 * An unlisted table returns nothing rather than sweeping the cache. A table
 * nobody has mapped is a table nobody is displaying live, and guessing wide
 * would make every unmapped write refetch the whole app.
 *
 * ⚠️ STILL TAKES A PLAIN `string`, ON PURPOSE. The compile-time guard lives on
 * `RealtimeTable`; this function is the runtime half, and it has to be able to
 * answer for a name that got past the type — a cast, a value read from a
 * migration, a table dropped from the map while a subscription still names it.
 * `[]` is the honest answer and `invalidateForTable` is what makes it audible.
 */
export function invalidatedBy(table: string): readonly QueryKey[] {
  return (INVALIDATES as Record<string, readonly QueryKey[]>)[table] ?? [];
}

/**
 * What a realtime ping does now: invalidate the keys, fetch nothing.
 *
 * ⚠️ EXTRACTED FROM THE HOOK SO IT CAN BE TESTED WITHOUT RENDERING ONE. The
 * client is a parameter and it is structurally typed, so a hand-written object
 * literal that records its calls is a complete test double — no mocking
 * framework, which `tests/unit/query-layer.test.ts` explains is a rule here and
 * not a preference. `QueryClient` satisfies this shape as it stands.
 *
 * ⚠️ INVALIDATION IS NOT A FETCH. `invalidateQueries` marks matching entries
 * stale and refetches only the ones something is currently OBSERVING — so a ping
 * for a key no mounted component reads costs a cache flag and no round trip.
 * That is the entire difference from `router.refresh()`, which re-rendered the
 * whole route whether anything on screen cared or not.
 *
 * Returns the keys it touched so the caller can tell "invalidated nothing"
 * apart from "invalidated something", which is the distinction the old
 * refresh-everything behaviour made impossible to see.
 */
export type RealtimeInvalidator = {
  invalidateQueries: (filters: { queryKey: QueryKey }) => unknown;
};

export function invalidateForTable(
  client: RealtimeInvalidator,
  table: string,
): readonly QueryKey[] {
  const keys = invalidatedBy(table);
  for (const queryKey of keys) {
    // Deliberately not awaited: `invalidateQueries` resolves when the refetches
    // it triggered settle, and a realtime ping has nobody to report that to.
    void client.invalidateQueries({ queryKey });
  }
  return keys;
}
