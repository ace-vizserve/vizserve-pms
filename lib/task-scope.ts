/**
 * The task-scope rules — which rows a view means — with NO server-only import,
 * so the server pages and the browser fetchers apply the same four filters.
 * Moved out of `lib/tasks-server.ts` in P12-07; that file re-exports all of it.
 */

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
