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

export const INVALIDATES: Record<string, readonly QueryKey[]> = {
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
};

/**
 * The keys one table event invalidates.
 *
 * An unlisted table returns nothing rather than sweeping the cache. A table
 * nobody has mapped is a table nobody is displaying live, and guessing wide
 * would make every unmapped write refetch the whole app.
 */
export function invalidatedBy(table: string): readonly QueryKey[] {
  return INVALIDATES[table] ?? [];
}
