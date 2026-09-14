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

/**
 * P9-05 — the "Mine" view is a COMPUTED COLUMN now, not a filter built here.
 *
 * `mineFilter` used to live at this spot and returned a PostgREST `or(...)`
 * fragment containing every id from `vizserve_pms_task_assignees`. Filters
 * travel in the URL; a real user with 444 rows produced a 16,542-character
 * query string and `fetch` failed outright — no status code, no PostgREST
 * error. Callers did `data ?? []`, so it rendered as an empty board.
 *
 * The rule now lives in `is_mine(vizserve_pms_tasks)` in Postgres and callers
 * ask for it with `.eq(MINE_COLUMN, true)`. Nothing variable-length is sent,
 * the single query keeps its filters and its ordering, and "what counts as
 * mine" has one home instead of two.
 *
 * Exported as a constant so the three call sites cannot misspell it — a wrong
 * column name here is a PostgREST error at runtime and nothing at compile time,
 * because it is a string the generated types have never heard of.
 */
export const MINE_COLUMN = "is_mine";

/**
 * P9-01 — the tasks somebody could hand over to a reliever.
 *
 * "Could hand over" is `vizserve_pms_is_on_task` — PIC, QA, or a row in
 * `vizserve_pms_task_assignees` — minus anything already finished.
 *
 * ⚠️ TWO QUERIES, AND THE REASON IS THE BUG THIS REPLACES.
 *
 * The first version built one `or(...)` fragment containing every joined task
 * id. A PostgREST filter travels in the URL, and one real user has 444 rows in
 * `vizserve_pms_task_assignees` — a 16,542-character query string. The request
 * did not return a PostgREST error, it did not return 414; `fetch` itself
 * failed. The page did `data ?? []` and rendered "You have no open tasks to
 * hand over" to somebody with 22 of them.
 *
 * So NOTHING VARIABLE-LENGTH GOES IN A FILTER. Both queries below carry one
 * uuid each, whatever the person's history looks like, and the join table is
 * reached through an `!inner` embed rather than by listing its ids.
 *
 * ⚠️ RETURNS ITS ERROR. Every other read in this file degrades to an empty
 * array on failure, deliberately — they WIDEN a set the caller already has. This
 * one IS the set, and an empty one is a sentence telling somebody they have no
 * work to hand over. That is the wrong zero `lib/approvals-queue-server.ts`
 * exists to prevent, in a new place, and it is exactly how this shipped broken.
 */
export async function fetchHandoverTasks(
  userId: string,
): Promise<{ tasks: { id: string; title: string }[]; error: { message: string } | null }> {
  const supabase = await createClient();

  // Named once: the four statuses split two ways everywhere in this app, and a
  // second spelling here would drift from the submit function's own test.
  const FINISHED = "(COMPLETED,COMPLETED_NO_RESPONSE)";

  const [own, joined] = await Promise.all([
    // The two COLUMNS. Fixed-length filter, always.
    supabase
      .from("vizserve_pms_tasks")
      .select("id, title, created_at")
      .or(`assignee_id.eq.${userId},qa_assignee_id.eq.${userId}`)
      .not("status", "in", FINISHED),

    /*
     * The JOIN TABLE, walked from its own side.
     *
     * `!inner` makes the embed a real inner join, so filtering the embedded
     * status drops the parent row too — which is what keeps finished tasks out
     * without a second pass. Reading it this way is what removes the id list
     * from the URL entirely.
     */
    supabase
      .from("vizserve_pms_task_assignees")
      .select("vizserve_pms_tasks!inner(id, title, created_at, status)")
      .eq("user_id", userId)
      .not("vizserve_pms_tasks.status", "in", FINISHED),
  ]);

  const error = own.error ?? joined.error ?? null;

  // A task reached both ways is one task. Somebody is routinely the PIC AND
  // carries a `task_assignees` row for the same work.
  const merged = new Map<string, { id: string; title: string; created_at: string }>();
  for (const task of own.data ?? []) merged.set(task.id, task);
  for (const row of (joined.data ?? []) as unknown as Array<{
    vizserve_pms_tasks: { id: string; title: string; created_at: string } | null;
  }>) {
    if (row.vizserve_pms_tasks) merged.set(row.vizserve_pms_tasks.id, row.vizserve_pms_tasks);
  }

  /*
   * NEWEST FIRST, and it cannot be an `.order()` now that the rows arrive from
   * two places.
   *
   * Newest rather than soonest-due, because the picker shows five and lets you
   * search for the rest: the five you most recently picked up are the five you
   * can recognise from a title, whereas the five due soonest are as likely to
   * be a stale deadline on something finished in all but status. Due date is
   * the right default for a BOARD, which is a different question.
   */
  const tasks = [...merged.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title))
    .map(({ id, title }) => ({ id, title }));

  return { tasks, error: error ? { message: error.message } : null };
}

/**
 * P12-02 — THE SCOPE FILTERS BOTH TASK VIEWS SHARE.
 *
 * `/tasks` and `/tasks/board` are the same rows drawn two ways, and each wrote
 * the filter chain out by hand — three times in total, because the board's
 * finished columns are a second query of their own. They had already drifted:
 * `?group=`, `?status=` and `?priority=` were added to the list and never to the
 * board, and the board's finished copy quietly grew an extra filter its own live
 * copy did not have. A shared cap bug on top of that is what made the Completed
 * column report 1 where the list reported 171.
 *
 * ⚠️ TAKES AND RETURNS THE BUILDER, which `lib/timesheet-tasks-server.ts` warns
 * against — and the warning does not apply here. What that header refuses is
 * threading ONE helper through two queries with DIFFERENT row shapes (a task
 * and a join-table embed), which needs a cast that throws the column checking
 * away. All three callers here select from `vizserve_pms_tasks`, so the builder
 * is the same type going in and coming out and nothing is cast.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: `?group=`, `?status=` and `?priority=`.
 * They are list-only, and that is a decision rather than an omission — the
 * toolbar drops them on the way to a board that is ORGANISED by status, and
 * `group` needs the `vizserve_pms_lists!inner(group_id)` embed in the select,
 * which the board's select does not carry. A filter this helper cannot express
 * for every caller does not belong in it.
 */

/** The three scopes the toolbar offers on both views. */
export type TaskView = "all" | "mine" | "qa";

/** Client work and internal work are two different jobs — see the toolbar. */
export type TaskKind = "all" | "client" | "internal";

/** The QA queue's two stages. */
export const QA_STAGES = ["FOR_QA", "QA_IN_PROGRESS"] as const;

export type TaskScope = {
  /** The list somebody is inside, or null for every list they can read. */
  listId: string | null;
  view: TaskView;
  kind: TaskKind;
  /** Whose view it is. Read only by `mine` and `qa`. */
  userId: string;
};

/** The subset of the PostgREST builder this touches. */
type ScopableTaskQuery<T> = {
  eq(column: "list_id" | "qa_assignee_id" | "is_mine", value: string | boolean): T;
  is(column: "request_id", value: null): T;
  not(column: "request_id", operator: "is", value: null): T;
  in(column: "status", values: readonly string[]): T;
};

export function applyTaskScope<T extends ScopableTaskQuery<T>>(query: T, scope: TaskScope): T {
  let scoped = query;

  if (scope.listId) scoped = scoped.eq("list_id", scope.listId);

  if (scope.kind === "client") scoped = scoped.not("request_id", "is", null);
  if (scope.kind === "internal") scoped = scoped.is("request_id", null);

  // P7-43 semantics, P9-05 mechanism — see MINE_COLUMN above.
  if (scope.view === "mine") scoped = scoped.eq(MINE_COLUMN, true);

  /*
   * ⚠️ THE STAGE NARROWING IS PART OF THE QA VIEW AND TRAVELS WITH IT.
   *
   * The board's finished query applied only the `qa_assignee_id` half, so the
   * QA view showed Completed cards there and none on the list — the same view,
   * two answers. Applied to a query already pinned to one terminal status it
   * yields nothing, which is the correct nothing: "waiting on my QA" is not a
   * question finished work can answer.
   */
  if (scope.view === "qa") {
    scoped = scoped.eq("qa_assignee_id", scope.userId).in("status", QA_STAGES);
  }

  return scoped;
}
