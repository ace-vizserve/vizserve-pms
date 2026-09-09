import type { QueryKey } from "@tanstack/react-query";

import { qk, type TaskPart } from "./keys";

/**
 * P12-06 — what a task WRITE invalidates, in one place.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS IS THE SECOND HALF OF EVERY CONTROL, NOT A REPLACEMENT FOR THE FIRST.
 *
 * The controls that write a task — `transition.tsx`, `inline.tsx`,
 * `assignees.tsx`, `delete-task-dialog.tsx`, `task-composer.tsx` — are SHARED.
 * The detail header renders them, every list row renders them, and every board
 * card renders them. `/tasks` and `/tasks/board` still read their rows in an
 * RSC, so they still repaint through `revalidatePath` + `router.refresh()` and
 * WILL until Phase 3c. So during the migration every one of those controls does
 * BOTH: it keeps its `router.refresh()` for the two server-rendered surfaces and
 * calls one of these for the one that now reads the cache.
 *
 * There is a precedent for exactly this, argued at length and for the same
 * reason: the `invalidate` callback in `hooks/use-realtime-refresh.ts` (P12-02)
 * invalidates the mapped keys AND still calls `router.refresh()`, because
 * invalidation only repaints something a query is OBSERVING and most of this app
 * is not observing anything yet. Same situation, same answer.
 *
 * ⚠️ AND `ded2244` IS WHY THE REFRESH MUST NOT COME OUT EARLY. Removing it from
 * these controls (`a64b06c`) had to be reverted the same day across eighteen
 * files: `useOptimistic` drops its value the instant the transition that set it
 * ENDS, and Next resolves the action's promise BEFORE the router commits the
 * revalidated tree — so the value snapped back to the old one, with the success
 * toast firing in the gap. The full account is the long note in
 * `app/(app)/tasks/inline.tsx`. Do not repeat it.
 *
 * ⚠️ WHICH IS ALSO WHY EVERY FUNCTION HERE IS `async` AND MUST BE AWAITED
 * INSIDE THE TRANSITION. `invalidateQueries` returns a promise that settles when
 * the refetches it triggered have landed. An un-awaited call lets the caller's
 * transition end before the fresh data arrives, which is `ded2244` again through
 * a different door — the optimistic value reverts, the cache repaints a beat
 * later, and the field visibly flickers. The one deliberate exception is
 * `markTaskStale` at the bottom, which is documented where it is used.
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
 */
export async function invalidateTaskWrite(client: Invalidator, taskId?: string): Promise<void> {
  await sweep(client, [
    ...(taskId ? [qk.task(taskId) as QueryKey] : []),
    qk.tasks(),
    qk.snapshot(),
  ]);
}

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
