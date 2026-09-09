import type { QueryKey } from "@tanstack/react-query";

import { qk, type TaskPart } from "./keys";

/**
 * P12-06 / P12-09 — what a task WRITE invalidates, in one place.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS IS THE WHOLE OF EVERY CONTROL NOW, AND IT USED TO BE HALF OF IT.
 *
 * The controls that write a task — `transition.tsx`, `inline.tsx`,
 * `assignees.tsx`, `delete-task-dialog.tsx`, `task-composer.tsx` — are SHARED.
 * The detail header renders them, every list row renders them, and every board
 * card renders them. For one phase the detail page read from the cache while the
 * list and the board still read in an RSC, so each control did BOTH: a
 * `router.refresh()` for the two server-rendered surfaces and one of these for
 * the one that was not. P12-07 moved all three onto the cache and P12-09 removed
 * the refresh. One mechanism.
 *
 * ⚠️ `ded2244` IS WHY THE AWAIT USED TO BE NON-NEGOTIABLE, AND P12-10 IS WHY IT
 * IS GONE. Removing the refresh from these controls (`a64b06c`) had to be
 * reverted the same day across eighteen files: `useOptimistic` drops its value
 * the instant the transition that set it ENDS, so SOMETHING had to stay pending
 * for the whole round trip, and an awaited invalidate was that something. It
 * worked, and it cost the entire surface: `qk.tasks()` is the prefix over the
 * list AND the board, so a one-field edit waited on seven queries in two waves
 * before the controls came back.
 *
 * ⚠️ `onMutate` REMOVED THE REASON FOR IT. The predicted value now lives in the
 * QUERY CACHE (`lib/query/task-cache.ts`), which keeps it until a refetch
 * replaces it — nothing reverts when a transition ends, because nothing about it
 * is scoped to one. So every call below is FIRED, not awaited, and the
 * interaction ends when the write returns.
 *
 * ⚠️ THE FUNCTIONS ARE STILL `async`, AND THAT IS NOT AN INVITATION. They return
 * the promise `invalidateQueries` returns so that a caller with a genuine reason
 * to wait can — `useTaskAutosave.flush()` is the one, and it says why at its
 * call site. Awaiting one from inside a click handler puts the refetch back in
 * front of the person, which is the whole of what this phase removed.
 * ------------------------------------------------------------------------
 */

/**
 * The bit of `QueryClient` these helpers use.
 *
 * Structural, for the reason `RealtimeInvalidator` in `realtime.ts` is
 * structural: a hand-written object literal that records its calls is then a
 * complete test double, and this repo has no mocking framework and does not
 * want one. `QueryClient` satisfies it as it stands.
 */
export type Invalidator = {
  invalidateQueries: (filters: { queryKey: QueryKey; refetchType?: "none" }) => Promise<unknown>;
};

async function sweep(client: Invalidator, keys: readonly QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/**
 * Invalidate WITHOUT waiting for the refetch.
 *
 * ⚠️ THE COUNTERPART TO `sweep`, AND CHOOSING BETWEEN THEM IS THE WHOLE OF
 * P12-08. Every control here used to `await` all of it and then toast, which
 * made a status change feel like a page load: 0.5–1s of nothing, then the row
 * moved, then the toast. The write had landed in the first 150ms of that.
 *
 * ⚠️ P12-10 MADE THIS THE ONLY MODE. What used to be awaited was whatever an
 * optimistic value was standing in for — `useOptimistic` drops its value when
 * its transition ends, so the transition had to outlive the refetch. The value
 * lives in the cache now, so there is nothing left to hold and `sweep` below has
 * one caller with a stated reason rather than eleven with an inherited one.
 */
function fire(client: Invalidator, keys: readonly QueryKey[]): void {
  for (const queryKey of keys) void client.invalidateQueries({ queryKey });
}

/**
 * A write that changed a task ROW: a status move, an inline field edit, a
 * reassignment, a delete.
 *
 * ⚠️ `qk.task(id)` SWEEPS EVERY PART OF THAT TASK, and that is deliberate rather
 * than lazy. TanStack matches by PREFIX, so `["task", id]` covers
 * `["task", id, "history"]` and the five other panels — which is exactly right
 * here, because a status move writes a `task_status_history` row, may write a
 * `client_decisions` row and changes the time the task has been sitting where it
 * is. Contrast `invalidateTaskPart` below, which is how a comment refetches the
 * thread and leaves the task alone.
 *
 * `qk.tasks()` and `qk.snapshot()` mirror the `vizserve_pms_tasks` row of
 * `INVALIDATES` in `lib/query/realtime.ts` — a task write moves the list views
 * and it moves the rail's open-task counts. Keeping the two lists in step is the
 * point of naming them both from one place.
 *
 * ⚠️ P12-08 FIRED THE RAIL AND AWAITED THE SURFACES; P12-10 FIRES BOTH. The
 * predicted row is in the cache, so there is no value on screen that a refetch
 * has to arrive in time to protect. Call this from `onSettled` and do not await
 * it — the interaction is over by then, and the refetch lands underneath a
 * screen that already shows the right thing.
 */
export async function invalidateTaskWrite(
  client: Invalidator,
  taskId?: string,
  options: { wait?: TaskWriteWait } = {},
): Promise<void> {
  const surfaces: QueryKey[] = [...(taskId ? [qk.task(taskId) as QueryKey] : []), qk.tasks()];

  if (options.wait === "everything") {
    await sweep(client, [...surfaces, qk.snapshot()]);
    return;
  }

  /*
   * The rail first and un-awaited, so its request is in flight alongside the
   * ones below rather than after them. Order matters only in that direction:
   * `fire` returns synchronously.
   */
  fire(client, [qk.snapshot()]);
  await sweep(client, surfaces);
}

/**
 * How much of a task write the caller is prepared to wait for.
 *
 * `"surfaces"` — the default — awaits the task and the list/board views and
 * lets the rail catch up on its own. `"everything"` is the pre-P12-08 behaviour,
 * kept for a caller that genuinely cannot proceed until the counts are right;
 * there is none today, and adding one should come with a reason at the call
 * site, because it puts a whole-tree aggregate back in front of a person.
 */
export type TaskWriteWait = "surfaces" | "everything";

/**
 * A write that changed ONE PANEL of a task and nothing else.
 *
 * This is the whole reason the key hierarchy has a third segment: posting a
 * comment refetches the comments, not the task row, not the history, not the
 * attachments and not the time rollup.
 *
 * `extra` is for the surfaces a panel write also moves — a comment changes the
 * latest-comment column on the task LIST (`latest-comment-cell.tsx`), which is
 * `qk.tasks()`, a different root that `["task", id]` cannot prefix-match however
 * long you stare at the pair. `INVALIDATES` records the same trap for the same
 * table.
 */
export async function invalidateTaskPart(
  client: Invalidator,
  taskId: string,
  part: TaskPart,
  extra: readonly QueryKey[] = [],
): Promise<void> {
  await sweep(client, [qk.taskPart(taskId, part), ...extra]);
}

/**
 * Mark a task stale WITHOUT refetching it.
 *
 * ⚠️ ONE CALLER, AND IT IS THE AUTOSAVED RESOLUTION (`use-task-autosave.ts`,
 * `refresh: false`). That field writes itself 800ms after the last keystroke,
 * and a refetch per pause is a round trip per pause on a textarea somebody is
 * still typing into — which is precisely what `refresh: false` was added to
 * stop. But leaving the cache entry FRESH is not an option either: the row in it
 * would still carry the old resolution, and the next component to read it (a
 * back-button restore, another tab) would show text the person has already
 * replaced.
 *
 * `refetchType: "none"` is the honest middle: the entry is stale, so the next
 * mount or focus refetches it, and nothing is fetched while the field is in use.
 * Not awaited by its caller for the same reason — there is no fetch to wait for.
 */
export function markTaskStale(client: Invalidator, taskId: string): void {
  void client.invalidateQueries({ queryKey: qk.task(taskId), refetchType: "none" });
}

/**
 * What a write changed that the OPTIMISTIC PATCH COULD NOT KNOW.
 *
 * ⚠️ DO NOT INVALIDATE WHAT YOU JUST PATCHED. `onMutate` already put the new
 * value in the cache and the server confirmed it; asking for the row back is
 * asking a question we have the answer to. Worse, it is not free: `qk.tasks()`
 * prefix-matches the list view, whose key bundles the rows AND their six
 * `.in("task_id", …)` lookups, so one status change fired about fourteen
 * background requests — and when the list one landed, TanStack replaced the
 * cached data and RE-RENDERED EVERY ROW ON THE PAGE over the top of a patch
 * that was already right. Ace felt that as the page lagging on a status update.
 *
 * So this invalidates only DERIVED data — the things a client cannot predict:
 *
 *   history   a move writes a `vizserve_pms_task_status_history` row, and may
 *             write a `client_decisions` row alongside it
 *   snapshot  the rail's open-task counts are aggregates over the whole
 *             department; the patch changed one row and cannot know the total
 *
 * ⚠️ THE ROW ITSELF IS DELIBERATELY ABSENT, and that is only safe because the
 * patch is precise. If a write ever changes a column the patch does not set —
 * a trigger writing `updated_at` into something displayed, a derived column —
 * it must be added here or the screen will hold a value that is quietly wrong.
 * `vizserve_pms_transition_task` promotes nothing and computes nothing the row
 * shows; `remove_task_assignee` DOES promote `assignee_id`, which is why the
 * seat control passes `alsoRow`.
 */
export function invalidateDerived(
  client: Invalidator,
  taskId: string,
  options: { alsoRow?: boolean } = {},
): void {
  const keys: QueryKey[] = [qk.taskPart(taskId, "history"), qk.snapshot()];

  // The one case where the server decides something the client cannot: removing
  // an assignee promotes the next one into `assignee_id`.
  if (options.alsoRow) keys.push(qk.tasks());

  fire(client, keys);
}
