import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";

/**
 * P7-13 / P7-43 — the tasks the caller is on WITHOUT being named in
 * `assignee_id`.
 *
 * ONE DEFINITION, BECAUSE THERE ARE NOW FOUR CALLERS AND THEY DRIFTED. The
 * database answers "is this person on this task" with `vizserve_pms_is_on_task`,
 * which is `assignee_id = them OR qa_assignee_id = them OR a row in
 * `vizserve_pms_task_assignees``. Four screens have to ask the same question,
 * and a policy function cannot be called from a PostgREST filter — so each of
 * them spelled it out, and three of them spelled it wrong:
 *
 *   * the timesheet picker offered PIC-or-QA only, so a second assignee had
 *     nowhere to log the hours the database would have accepted
 *   * the task list and the board computed `isPic` from the column alone, so a
 *     second assignee saw a read-only page while the UPDATE policy — which goes
 *     through the helper — would have taken their edits
 *   * "Mine" filtered on the column alone, so work somebody was demonstrably
 *     doing did not appear in the view named after them
 *
 * This returns only the JOIN-TABLE half. Callers still test `assignee_id` and
 * `qa_assignee_id` themselves, because those two are columns on the rows they
 * are already fetching and a second query for them would be waste. What matters
 * is that the half nobody remembered lives in one place.
 *
 * `cache()`d per request: the tasks page needs it for `seat()` AND for the Mine
 * filter, and both run in the same render.
 *
 * ⚠️ RETURNS AN EMPTY ARRAY ON FAILURE rather than throwing. Every caller uses
 * it to WIDEN a set — the tasks they can already reach through `assignee_id`.
 * Degrading to "no extra tasks" shows somebody less than they should see; a
 * throw takes out the whole board. The first is a bug report, the second is an
 * outage.
 */
export const fetchJoinedTaskIds = cache(async (userId: string): Promise<string[]> => {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("vizserve_pms_task_assignees")
    .select("task_id")
    .eq("user_id", userId);

  if (error) return [];

  return (data ?? []).map((row) => row.task_id);
});

/**
 * The same set as a `Set`, for the per-row membership tests that `seat()` and
 * its equivalents do once per task on screen.
 */
export const fetchJoinedTaskIdSet = cache(async (userId: string): Promise<Set<string>> => {
  return new Set(await fetchJoinedTaskIds(userId));
});

/*
 * ⚠️ `MINE_COLUMN` MOVED TO `lib/schemas/tasks.ts` IN P12-07, AND IT IS
 * RE-EXPORTED HERE SO EVERY EXISTING IMPORT STILL RESOLVES.
 *
 * This module opens with `import "server-only"`, which is the whole reason it
 * had to move: `/tasks` and `/tasks/board` build their queries in the BROWSER
 * now, and a client bundle reaching into this file is a build error by design.
 * The constant had exactly one job — "the three call sites cannot misspell it,
 * because a wrong column name here is a PostgREST error at runtime and nothing
 * at compile time" — and that job only works while there is ONE definition of
 * it. Copying it into a client-safe module would have been two.
 *
 * `lib/schemas/tasks.ts` is where it lives now: no `server-only`, and already
 * the home of every other shared rule about what a task is.
 */
export { MINE_COLUMN } from "@/lib/schemas/tasks";

/*
 * ⚠️ `fetchHandoverTasks` MOVED TO `lib/query/fetchers/approvals.ts` IN P12-19,
 * WITH THE CLIENT AS A PARAMETER AND NOTHING ELSE CHANGED.
 *
 * It had exactly one caller — `/approvals` — and that page is a client tree now.
 * This module opens with `import "server-only"`, so the import would have been a
 * build error by design; the same reason `MINE_COLUMN` moved out above.
 *
 * Everything that made it worth reading travelled with it: the two fixed-length
 * queries (a filter carrying 444 joined task ids was a 16,542-character URL that
 * `fetch` refused outright, and `?? []` rendered it as "you have no open tasks
 * to hand over" to somebody with 22), the `!inner` embed, the merge, and the
 * newest-first sort with its argument. It is NOT re-exported from here, because
 * unlike `MINE_COLUMN` it had no other importer to keep working.
 */
