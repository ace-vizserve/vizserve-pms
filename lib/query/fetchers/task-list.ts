import type { PostgrestError } from "@supabase/supabase-js";

import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { parseAll } from "@/lib/query/parse";
import { read } from "@/lib/query/read";
import {
  boardTaskRowSchema,
  listCommentRowSchema,
  listCoverageRowSchema,
  pendingRequestRowSchema,
  taskAssigneeLinkSchema,
  taskChildRowSchema,
  taskClosedRowSchema,
  taskFolderSchema,
  taskListRowSchema,
  type BoardTaskRow,
  type ListCommentRow,
  type ListCoverageRow,
  type TaskAssigneeLink,
  type TaskChildRow,
  type TaskClosedRow,
  type TaskFolder,
  type TaskListRow,
} from "@/lib/schemas/task-list";
import { taskTimeTrackedSchema } from "@/lib/schemas/task-detail";
import { pendingRequestsApply, type PendingRequest } from "@/lib/schemas/approvals";
import { MINE_COLUMN, type TaskPriority } from "@/lib/schemas/tasks";

import type { TaskReadClient } from "./task";

/**
 * P12-07 — the reads behind `/tasks` and `/tasks/board`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES. Both pages were RSCs that awaited a row query and then a
 * batch of six more against the ids it returned — fourteen queries between them
 * — inside a single cache entry, the route's own render. Ticking a priority on
 * one row therefore re-ran the comments, the subtasks, the time rollup, the
 * coverage view, the assignee join and the closed-date history for eighty rows,
 * plus the whole shell above them. The reads are now three query keys
 * (`qk.taskList`, `qk.taskBoard`, `qk.taskView`) that a write invalidates
 * directly, and the shell is not in the path at all.
 *
 * ⚠️ THE ROWS AND THEIR SIX LOOKUPS SHARE ONE KEY, ON PURPOSE, and it is the
 * same argument `fetchTaskDetail` makes for its three reads. Every lookup here
 * is `.in("task_id", <the ids this query just returned>)` — they are not
 * independent facts about a list, they are facts about THIS RESULT SET. Split
 * into keys of their own they could only ever be refetched together anyway, and
 * arriving apart would mean a row rendering its neighbour's comment thread for a
 * frame. The plan flags this as the read that "does not split cleanly into
 * per-task keys"; this is what not splitting it looks like.
 *
 * ⚠️ SO THE SECOND WAVE IS DEPENDENT, AND THAT IS TWO ROUND TRIPS, NOT ONE. It
 * was two in the RSC as well — the ids have to come back before anything can be
 * asked about them. Nothing here made it slower, but it is the one honest cost
 * of the shape and it belongs in the open: a list of eighty rows is one query,
 * then six in parallel.
 *
 * ------------------------------------------------------------------------
 * ⚠️ NOTHING HERE RESTATES A SCOPE FILTER, and nothing here may start to. RLS is
 * the enforcement layer (CLAUDE.md): a member sees tasks where they are PIC or
 * QA and a lead sees their department's, so the SAME query answers both and
 * adding `.eq("department_id", …)` would imply the policy were optional. The
 * `mine` and `qa` narrowings below are not scope filters — they narrow WITHIN
 * what the reader can already see, to the work that is theirs to move.
 *
 * ⚠️ AND NOTHING VARIABLE-LENGTH GOES IN A FILTER. P9-05: `mineFilter` built an
 * `or(...)` holding every joined task id, which for a real user with 444 of them
 * was a 16,542-character URL that `fetch` refused with no status and no message
 * — rendered by `data ?? []` as an empty board. `MINE_COLUMN` is a computed
 * column answered in Postgres and sends a boolean. The `.in("task_id", ids)`
 * calls below are a different thing and are fine: supabase-js sends those as a
 * parameter rather than as hand-built text, and the ids are the page's own
 * result set rather than an unbounded history. `tests/unit/task-filters.test.ts`
 * guards the distinction.
 *
 * ⚠️ EVERY READ GOES THROUGH `read()`, WHICH THROWS. There is no `?? []` in this
 * file and there must never be one — see `lib/query/read.ts` for the two shipped
 * bugs that rule exists to prevent.
 */

/* -------------------------------------------------------------------------- */
/* The sort contract.                                                          */
/* -------------------------------------------------------------------------- */

/**
 * P7-65 — the columns `?sort=` is allowed to name.
 *
 * `due` and `priority` are the two the toolbar Select has always offered; the
 * rest are the columns whose header is a control.
 *
 * ⚠️ SORTING THE QUERY IS WHAT MAKES THIS WORK ON A GROUPED LIST. The rows are
 * ordered before they are split into stages, so all eight tables reorder
 * together. A browser-side sort would have reordered each group independently
 * and meant nothing across them, which is why the headers were left inert when
 * the tables first moved onto TanStack.
 */
export const TASK_SORTS = ["due", "priority", "title", "start", "estimate"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export function isTaskSort(value: string | undefined): value is TaskSort {
  return typeof value === "string" && (TASK_SORTS as readonly string[]).includes(value);
}

/**
 * The order applied when the URL asks for none: by deadline, soonest first.
 *
 * `tasks-table.tsx` passes the same pair to `DataTable` as `defaultSort`, which
 * is the only reason the headers can draw an arrow for an order nobody put in
 * the query string — change one and change the other or it goes back to lying
 * about it.
 */
export const DEFAULT_TASK_SORT = { sort: "due", ascending: true } as const;

/**
 * ⚠️ A LITERAL COLUMN PER KEY, NEVER `.order(params.sort)`.
 *
 * `?sort=` is a string somebody can type, and an unknown column name reaches
 * Postgres as `invalid input value` and 500s the page. It was a record on the
 * server and it is a record here; the value crossing into the browser changed
 * nothing about how much of it is user input.
 */
const ORDER_COLUMN: Record<TaskSort, string> = {
  due: "due_date",
  priority: "priority",
  title: "title",
  start: "start_date",
  estimate: "estimate_minutes",
};

/* -------------------------------------------------------------------------- */
/* What the two surfaces ask for.                                              */
/* -------------------------------------------------------------------------- */

/** `?view=`. `mine` and `qa` are the two cross-list views (P3-08). */
export type TaskViewScope = "all" | "mine" | "qa";
/** `?kind=`. "internal" INCLUDES personal work — `request_id` is the only test. */
export type TaskViewKind = "all" | "internal" | "client";

export type TaskListParams = {
  listId: string | null;
  view: TaskViewScope;
  kind: TaskViewKind;
  /** Validated against the enum by the caller; `null` is "no status filter". */
  status: VizservePmsTaskStatus | null;
  /** P7-18 — a FOLDER, reached through the list by an embed. See below. */
  groupId: string | null;
  priority: TaskPriority | null;
  /** Raw from the URL. Mapped through `ORDER_COLUMN`, never passed to `.order`. */
  sort?: string;
  dir?: string;
  /** The signed-in user, for the QA queue. Never a scope decision. */
  userId: string;
};

/**
 * Everything `/tasks` renders, from one key.
 *
 * The rows plus the six lookups the row cells read. The DERIVATIONS — the
 * parent/child nesting, the status buckets, the comment threads with their
 * authors resolved — stay in the component, because they need the directory,
 * which is a different key (`qk.ref("users")`) shared with every other surface.
 */
export type TaskListView = {
  rows: TaskListRow[];
  comments: ListCommentRow[];
  children: TaskChildRow[];
  tracked: { task_id: string; minutes: number }[];
  coverage: ListCoverageRow[];
  assignees: TaskAssigneeLink[];
  closed: TaskClosedRow[];
};

/**
 * The fifteen columns a row needs.
 *
 * K3/K5 — THE ROW IS EDITABLE AND IT CARRIES ITS NUMBERS. Title, both dates,
 * priority and the estimate change from the row without opening anything;
 * progress, time tracked and the latest comment are read there without opening
 * anything. Every one is either already in the column-level UPDATE grant or
 * derived from a query, so none of it needed a migration.
 */
const TASK_COLUMNS =
  "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, list_id, request_id, is_personal, priority, estimate_minutes, parent_task_id, resolution";

/**
 * ⚠️ THE ONE CAST IN THIS FILE, AND IT IS THE CONDITIONAL SELECT STRING.
 *
 * supabase-js types a query by parsing the select string AT THE TYPE LEVEL, and
 * it can only do that for a literal. The folder embed makes the string a union
 * of two, which it reports as a `ParserError` — a type-level complaint about a
 * string, not a claim that the rows are wrong. The RSC this replaces carried the
 * identical cast for the identical reason, and the alternative is the same one
 * it rejected: two literal branches, which means maintaining the sixteen-column
 * list twice and drifting the first time somebody adds a column to one.
 *
 * It costs nothing in safety here that it did not cost there, and rather less:
 * every row that comes back is parsed by `taskListRowSchema` a few lines down,
 * so a column that stopped arriving is a `ReadError` with a sentence rather than
 * an `undefined` in a cell.
 */
type RawRows = PromiseLike<{ data: unknown[] | null; error: PostgrestError | null }>;

export async function fetchTaskListView(
  client: TaskReadClient,
  params: TaskListParams,
): Promise<TaskListView> {
  /* `undefined` when the URL named no sort we recognise, and that distinction is
     load-bearing: it decides whether `?dir=` is obeyed at all, so it cannot be
     collapsed into `sort`. */
  const requested = isTaskSort(params.sort) ? params.sort : undefined;
  const sort: TaskSort = requested ?? DEFAULT_TASK_SORT.sort;

  /*
   * P7-65 — ONE SOURCE FOR THE DIRECTION.
   *
   * An explicit sort obeys `?dir=` — ascending unless it says otherwise, which
   * is why the table leaves `asc` out of the URL — and no explicit sort takes
   * the default's. This used to read the direction off the COLUMN NAME instead,
   * so a click on "Priority" wrote `?sort=priority` with no `dir`, the header
   * drew an ascending arrow and the server returned descending rows, and that
   * column could not be sorted ascending at all.
   *
   * Priority still reads highest-first where it is meant to: the toolbar Select
   * writes `dir=desc` beside it, because that is now the only thing that says
   * so. It is a Postgres enum declared LOW → HIGH, so `descending` is
   * highest-first with no CASE and no lookup table — the same trick the role
   * enum relies on.
   */
  const ascending = requested ? params.dir !== "desc" : DEFAULT_TASK_SORT.ascending;

  /*
   * P7-18 — filtering by FOLDER needs an embed, not an `.eq()`.
   *
   * A task carries `list_id` and never `group_id` (deliberately: a task holding
   * its own folder would be a second source of truth that disagrees with its
   * list the first time a list moves). So the folder is reached through the
   * list, and PostgREST does that with an embedded filter.
   *
   * `!inner` is what makes the filter actually restrict rather than just
   * decorate the rows — and it also drops tasks with no list at all, which is
   * right when a folder is selected, since a task with no list has no folder.
   * That is also why the embed is CONDITIONAL: always-on `!inner` would silently
   * hide every list-less task from the unfiltered board.
   */
  let query = client
    .from("vizserve_pms_tasks")
    .select(
      params.groupId ? `${TASK_COLUMNS}, vizserve_pms_lists!inner(group_id)` : TASK_COLUMNS,
    )
    // `nullsFirst: false` is what puts the unranked, undated majority at the
    // bottom instead of on top of the work that has a deadline.
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    // A stable tie-break, so two tasks due the same day do not swap places
    // between renders.
    .order("created_at", { ascending: false });

  if (params.status) query = query.eq("status", params.status);
  if (params.listId) query = query.eq("list_id", params.listId);
  if (params.groupId) query = query.eq("vizserve_pms_lists.group_id", params.groupId);
  if (params.priority) query = query.eq("priority", params.priority);
  if (params.kind === "client") query = query.not("request_id", "is", null);
  if (params.kind === "internal") query = query.is("request_id", null);
  /*
   * P7-43 semantics, P9-05 mechanism. "Mine" is the accountable name PLUS, on
   * internal tasks only, being on the task at all — internal work has no person
   * in charge, so membership is the whole of the claim. Answered in Postgres;
   * see the file header for the URL this replaced.
   */
  if (params.view === "mine") query = query.eq(MINE_COLUMN, true);
  // P3-08 — the QA queue is a view of this list, not a separate screen with a
  // separate set of rules that can drift from it.
  if (params.view === "qa") {
    query = query
      .eq("qa_assignee_id", params.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  const rows = parseAll(taskListRowSchema, await read<unknown[]>(query as RawRows), "tasks");
  const taskIds = rows.map((task) => task.id);

  /*
   * ⚠️ NO IDS, NO SECOND WAVE — AND `[]` HERE IS A REAL EMPTY, NOT A SWALLOWED
   * FAILURE. The row query above either threw or returned rows; reaching this
   * with none means the filters matched nothing, and asking six questions about
   * an empty set is six round trips for six guaranteed empty answers.
   */
  if (taskIds.length === 0) {
    return { rows, comments: [], children: [], tracked: [], coverage: [], assignees: [], closed: [] };
  }

  /*
   * Six queries against the visible ids, run together.
   *
   * All six are scoped by `.in()` on ids the policy has ALREADY returned, so a
   * task somebody cannot see cannot have its comments, its children or its hours
   * pulled in through the back door — and each of the six has its own policy
   * underneath this anyway.
   */
  const [commentRows, childRows, trackedRows, coverageRows, assigneeRows, closedRows] =
    await Promise.all([
      /*
       * P7-08 / K5 — every comment on every visible task, in ONE query.
       *
       * A query per row is an N+1 on the page people leave open all day, and the
       * cell needs the whole thread rather than just the last line: clicking it
       * opens the conversation in place, so fetching only the latest would mean
       * a second round trip on every open.
       */
      read<unknown[]>(
        client
          .from("vizserve_pms_task_comments")
          .select("id, task_id, body, author_id, created_at, updated_at")
          .in("task_id", taskIds)
          .order("created_at", { ascending: true }),
      ),

      /*
       * K5 — PROGRESS COMES FROM THE SUBTASKS, and it is fetched rather than
       * derived from the rows above.
       *
       * Deriving it from what is already on screen would be wrong under every
       * filter: a status filter or the `mine` view hides most children, so a
       * parent would report 1/1 done because that is all the page happened to
       * load. P7-09 is one level deep and trigger-enforced, so this is a single
       * flat query — no recursion, and no stored counter to drift.
       */
      read<unknown[]>(
        client
          .from("vizserve_pms_tasks")
          .select("id, parent_task_id, status")
          .in("parent_task_id", taskIds),
      ),

      /*
       * P7-15 / K5 — TIME TRACKED CANNOT BE A PLAIN SUM. This is the trap.
       *
       * `vizserve_pms_timesheet_entries`' SELECT policy is owner-or-their-lead,
       * so a member summing that table for a task sees only the hours THEY
       * logged and calls it the task total. Two people on one task would read
       * two different figures on the same row and a lead a third. Nobody reports
       * that as a bug; they quietly stop trusting the column.
       *
       * So it is a SECURITY DEFINER rollup that sums inside and returns a row
       * only for tasks the caller may already see — same shape and same reason
       * as `vizserve_pms_leave_calendar`. A task nobody has logged against is
       * simply absent from the result, which is a real zero rather than a `?? 0`
       * over a failure.
       */
      read<unknown[]>(client.rpc("vizserve_pms_task_time_tracked", { p_task_ids: taskIds })),

      /*
       * P9-01 — who is holding which of these while somebody is away.
       *
       * `vizserve_pms_active_task_coverage` already filters to APPROVED leave
       * whose dates contain today in Manila, so this is a lookup rather than a
       * date calculation, and it is scoped to the ids on screen.
       *
       * ⚠️ ON THE LIST AND NOT ONLY THE DETAIL. "The person whose name is on this
       * row is away until Friday" is exactly the fact somebody scanning a board
       * needs, and it is the one place they will not think to open the task to
       * find out. Ordinarily this returns nothing at all.
       *
       * `security_invoker`, so a reader who cannot see the leave request behind
       * it gets no row — which is right for a request whose reason they have no
       * business reading.
       */
      read<unknown[]>(
        client
          .from("vizserve_pms_active_task_coverage")
          .select("task_id, reliever_id, end_date")
          .in("task_id", taskIds),
      ),

      /*
       * P7-13 — everyone on the visible tasks, in one query.
       *
       * The row shows the accountable name and a `+n`, so it needs the join
       * table as well as `assignee_id`. The table has its own policy; this is
       * scoped by `.in()` on ids the tasks policy has already returned.
       *
       * ⚠️ IT IS ALSO WHAT ANSWERS `isAssignee` ON EVERY ROW. `tasks-table.tsx`
       * mirrors `vizserve_pms_transition_task`'s `v_is_pic` — the column OR a
       * row in this table — out of `lookups.extraAssignees`, which is why the
       * list needs no equivalent of the board's joined-id set.
       */
      read<unknown[]>(
        client
          .from("vizserve_pms_task_assignees")
          .select("task_id, user_id")
          .in("task_id", taskIds),
      ),

      /*
       * K5 — DATE CLOSED, AND IT NEEDS NO COLUMN.
       *
       * `vizserve_pms_task_status_history` already records the move to
       * COMPLETED / COMPLETED_NO_RESPONSE with its timestamp, so reading it from
       * there is one query and cannot disagree with the trail — which a
       * `completed_at` column eventually would.
       *
       * Ordered ASCENDING and reduced by last-write-wins in the component, so a
       * REOPENED task (P7-06 lets internal work go COMPLETED → ONGOING) reports
       * the date it was closed MOST RECENTLY rather than the first time.
       */
      read<unknown[]>(
        client
          .from("vizserve_pms_task_status_history")
          .select("task_id, to_status, created_at")
          .in("task_id", taskIds)
          .in("to_status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
          .order("created_at", { ascending: true }),
      ),
    ]);

  return {
    rows,
    comments: parseAll(listCommentRowSchema, commentRows, "comments"),
    children: parseAll(taskChildRowSchema, childRows, "subtasks"),
    tracked: parseAll(taskTimeTrackedSchema, trackedRows, "time tracked"),
    coverage: parseAll(listCoverageRowSchema, coverageRows, "task coverage"),
    assignees: parseAll(taskAssigneeLinkSchema, assigneeRows, "assignees"),
    closed: parseAll(taskClosedRowSchema, closedRows, "closing dates"),
  };
}

/* -------------------------------------------------------------------------- */
/* The board.                                                                  */
/* -------------------------------------------------------------------------- */

/** How many finished cards a terminal column shows before it stops. */
export const FINISHED_PER_COLUMN = 12;

const BOARD_COLUMNS_SELECT =
  "id, title, status, due_date, start_date, assignee_id, qa_assignee_id, department_id, created_by, request_id, is_personal, priority, output_link, parent_task_id, list_id, resolution";

export type BoardParams = {
  listId: string | null;
  view: TaskViewScope;
  kind: TaskViewKind;
  userId: string;
};

export type TaskBoardView = {
  /** Everything not finished, ordered by deadline. Unbounded, and naturally so. */
  live: BoardTaskRow[];
  /** The two terminal columns, most recent first and capped. */
  finished: BoardTaskRow[];
  /** K5 — every child of a visible parent, INCLUDING the finished ones. */
  children: TaskChildRow[];
  /**
   * P7-13 — everyone on the visible cards.
   *
   * ⚠️ THIS IS THE BOARD'S `isAssignee`, AND IT USED TO COME FROM THE SERVER.
   * `BoardColumns` called `fetchJoinedTaskIdSet(userId)` — every task the reader
   * is on anywhere, ever — and asked it per card. That read is `server-only`, it
   * cannot follow the query into the browser, and passing its result down as a
   * prop would have frozen it: after P12-09 the route does not re-render on a
   * write, so joining a task would not repaint the card's controls until a
   * navigation.
   *
   * So the board asks the question the LIST has always asked instead —
   * `.in("task_id", <the cards on screen>)`, the same join table, the same
   * mirror of `vizserve_pms_transition_task`'s `v_is_pic`. It is scoped to ids
   * the tasks policy has already returned, it is invalidated by the same key as
   * the cards, and the two surfaces now compute the seat identically rather than
   * from two different reads.
   */
  assignees: TaskAssigneeLink[];
};

export async function fetchTaskBoardView(
  client: TaskReadClient,
  params: BoardParams,
): Promise<TaskBoardView> {
  let query = client
    .from("vizserve_pms_tasks")
    .select(BOARD_COLUMNS_SELECT)
    .order("due_date", { ascending: true, nullsFirst: false })
    /*
     * ⚠️ THE TIE-BREAK, WHICH THE BOARD DID NOT HAVE (P12-07).
     *
     * `due_date` alone is not a total order and most cards have none, so
     * Postgres was free to return the undated ones — the majority of a column —
     * in a different order on every read. It looked like cards shuffling
     * themselves whenever anything on the page refetched, and it will look far
     * worse now that a refetch happens on every write rather than on a
     * navigation. `/tasks` has ordered by `created_at desc` behind its sort
     * since it was built; this is the same line, so the two views deal the same
     * cards in the same order.
     */
    .order("created_at", { ascending: false });

  /*
   * ⚠️ EVERY STAGE IS A COLUMN, COMPLETED AND COMPLETED (NO RESPONSE) INCLUDED.
   *
   * The board file used to say the opposite, and half of the old reasoning is
   * still true: "a column that accumulates every finished ticket since launch
   * stops being a board and becomes an archive nobody scrolls." The archive
   * worry is real; omitting the columns was the wrong answer to it. A board
   * whose columns are not the status enum disagrees with the list, the status
   * dropdown and the state machine about what the stages are.
   *
   * The archive problem is solved where it lives — in HOW MUCH is fetched. Live
   * work is unbounded because it is naturally bounded; finished work is capped
   * and the column says so when there is more.
   */
  query = query.not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)");

  if (params.listId) query = query.eq("list_id", params.listId);

  // The same three scopes the toolbar offers on both views. The board used to
  // read `mine` and silently ignore `qa`, which is what a control living on only
  // one of the two routes gets you.
  // P7-43 — same rule as the list view, through the same computed column.
  if (params.view === "mine") query = query.eq(MINE_COLUMN, true);
  if (params.view === "qa") {
    query = query
      .eq("qa_assignee_id", params.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]);
  }

  if (params.kind === "client") query = query.not("request_id", "is", null);
  if (params.kind === "internal") query = query.is("request_id", null);

  /*
   * Finished work, as its own bounded read, in the same wave.
   *
   * A SEPARATE QUERY rather than relaxing the filter above, because the two want
   * opposite things. Live work is ordered by due date and unbounded — there is
   * only ever so much of it. Finished work is ordered by RECENCY and capped:
   * what closed this week is worth a glance, what closed in March is what the
   * list view and its filters are for.
   *
   * ⚠️ A cap without a stated limit is a lie about the number. `* 2 + 1` is
   * asked for because the rows feed BOTH terminal columns and truncation has to
   * be DETECTABLE without a second count query — the same trick the DTR list
   * uses, and for the same reason: a board that quietly shows twelve of forty is
   * a board somebody counts off.
   *
   * Carries the same list/scope/kind filters as the board, so the columns agree
   * with the ones beside them.
   */
  let done = client
    .from("vizserve_pms_tasks")
    .select(BOARD_COLUMNS_SELECT)
    .in("status", ["COMPLETED", "COMPLETED_NO_RESPONSE"])
    .order("updated_at", { ascending: false })
    // Same tie-break argument as the live query above: `updated_at` is far more
    // distinguishing than a due date, but two rows written by one statement —
    // a bulk delete, a cascade — share it exactly.
    .order("created_at", { ascending: false })
    .limit(FINISHED_PER_COLUMN * 2 + 1);

  if (params.listId) done = done.eq("list_id", params.listId);
  if (params.view === "mine") done = done.eq(MINE_COLUMN, true);
  if (params.view === "qa") done = done.eq("qa_assignee_id", params.userId);
  if (params.kind === "client") done = done.not("request_id", "is", null);
  if (params.kind === "internal") done = done.is("request_id", null);

  const [liveRows, finishedRows] = await Promise.all([
    read<unknown[]>(query as RawRows),
    read<unknown[]>(done as RawRows),
  ]);

  const live = parseAll(boardTaskRowSchema, liveRows, "the board");
  const finished = parseAll(boardTaskRowSchema, finishedRows, "finished work");

  /*
   * K5 — PROGRESS, AND THE BOARD CANNOT DERIVE IT THE WAY THE LIST DOES.
   *
   * The live query excludes the two terminal statuses, so a finished subtask is
   * not in `live` at all — counting done children from those rows would report
   * 0/3 on a task whose three subtasks are all complete. Hence a separate query,
   * unfiltered by status, and hence its dependence on the ids above.
   */
  const parentIds = live.filter((task) => !task.parent_task_id).map((task) => task.id);
  /* Every card that will be drawn, finished columns included — the seat decides
     which moves a card offers, and a finished card still offers some. */
  const cardIds = [...live.map((task) => task.id), ...finished.map((task) => task.id)];

  if (cardIds.length === 0) return { live, finished, children: [], assignees: [] };

  const [childRows, assigneeRows] = await Promise.all([
    parentIds.length
      ? read<unknown[]>(
          client
            .from("vizserve_pms_tasks")
            .select("id, parent_task_id, status")
            .in("parent_task_id", parentIds),
        )
      : Promise.resolve([] as unknown[]),

    read<unknown[]>(
      client
        .from("vizserve_pms_task_assignees")
        .select("task_id, user_id")
        .in("task_id", cardIds),
    ),
  ]);

  return {
    live,
    finished,
    children: parseAll(taskChildRowSchema, childRows, "subtasks"),
    assignees: parseAll(taskAssigneeLinkSchema, assigneeRows, "assignees"),
  };
}

/* -------------------------------------------------------------------------- */
/* The two pickers both surfaces share.                                        */
/* -------------------------------------------------------------------------- */

/**
 * `qk.ref("task-groups")` — P7-18, the folders for the filter panel.
 *
 * The reserved system folder is offered like any other: "show me everything that
 * came through a form" is a filter people want, and it is the one folder
 * guaranteed to exist.
 */
export async function fetchTaskFolders(client: TaskReadClient): Promise<TaskFolder[]> {
  const rows = await read<unknown[]>(
    client
      .from("vizserve_pms_task_groups")
      .select("id, name")
      .eq("is_active", true)
      .order("sort_order")
      .order("name"),
  );

  return parseAll(taskFolderSchema, rows, "folders");
}

/**
 * ⚠️ `fetchDepartments` MOVED TO `lib/query/fetchers/ref.ts` IN P12-20, AND IT
 * WAS WIDENED ON THE WAY.
 *
 * It lived here with a comment that said what was coming — "every picker in
 * Phase 6 wants the same rows" — and that is what happened, except that the
 * five new consumers want a WIDER row set than this one did. It read
 * `.eq("is_active", true)`, which is right for the create picker that was its
 * only caller and wrong for `/reports`, `/forms` and `/hr/reports`, all of
 * which need to NAME a department rather than offer a seat in it. The filter is
 * now the caller's, exactly as `fetchDirectory` made `is_active` the caller's
 * on the staff directory in P12-07.
 *
 * The whole argument is at the function's new home. It is not re-exported from
 * here: `new-task-button.tsx` is the only file that imported it and the picker
 * it feeds now filters that column itself, so a line that hid where the rows
 * come from would hide the one thing that call site has to remember.
 */

/**
 * `qk.pendingRequests(...)` — P7-26, the requests that have not been decided.
 *
 * ⚠️ THE RULES ABOUT WHICH FILTERS A REQUEST CAN ANSWER ARE NOT REPEATED HERE.
 * `pendingRequestsApply` (lib/schemas/approvals.ts) is pure and unit-tested and
 * owns them; this is the query and nothing else, which is the division
 * `lib/pending-requests-server.ts` followed before the read moved to the
 * browser. The caller asks that function whether to run this at all — through
 * `enabled`, so a filtered view issues no request rather than one it discards.
 *
 * ⚠️ SCOPE IS RLS'S JOB. `vizserve_pms_requests` is readable only by a lead of
 * the form's department, so this returns nothing at all for a member — which is
 * right, since approving is not theirs to do — and the caller renders nothing
 * rather than an empty heading. There is no role check here and there must not
 * be one.
 *
 * ⚠️ AND IT THROWS NOW, WHERE THE SERVER VERSION RETURNED `[]`. That degrade was
 * a judgement — these rows are an ADDITION to a page whose main job is tasks,
 * and a failed request query must not take the task list down with it. The
 * judgement stands and the mechanism changed: the query lands in `isError`, its
 * own component says so in the space the queue would have occupied, and the
 * tasks beside it are unaffected because they are a different key. What is gone
 * is the half of the old behaviour nobody chose — a failure reading as "nothing
 * waiting", which is the whole of P12-01.
 */
export async function fetchPendingRequests(
  client: TaskReadClient,
  filters: { listId: string | null; kind: TaskViewKind; scope: TaskViewScope; hasTaskOnlyFilter?: boolean },
): Promise<PendingRequest[]> {
  /* Belt and braces: the caller gates this with `enabled`, and a query that ran
     anyway must not return rows the page has decided not to show. */
  if (!pendingRequestsApply(filters)) return [];

  let query = client
    .from("vizserve_pms_requests")
    /*
     * `!inner` because the form is not decoration here — it carries the list
     * this request will land in, and the `?list=` filter below goes THROUGH the
     * embed rather than fetching the form's list first.
     */
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, submitted_at, vizserve_pms_forms!inner(name, default_list_id)",
    )
    .eq("status", "PENDING_REVIEW")
    /*
     * OLDEST FIRST, and it is deliberately the opposite of the task list.
     *
     * A task list is read by deadline — what is due soonest. A queue is read by
     * how long something has been sitting there, because the failure mode of a
     * review queue is a request nobody looked at, not a request looked at in the
     * wrong order.
     */
    .order("submitted_at", { ascending: true, nullsFirst: false });

  // The form's inbox list is where this request's task will land, so filtering
  // the page to one list filters these to the requests destined for it.
  if (filters.listId) {
    query = query.eq("vizserve_pms_forms.default_list_id", filters.listId);
  }

  const rows = parseAll(
    pendingRequestRowSchema,
    await read<unknown[]>(query as RawRows),
    "requests awaiting approval",
  );

  return rows.map((row) => ({
    id: row.id,
    reference_no: row.reference_no,
    title: row.title,
    requester_name: row.requester_name,
    requester_org: row.requester_org,
    target_date: row.target_date,
    submitted_at: row.submitted_at,
    listId: row.vizserve_pms_forms?.default_list_id ?? null,
    formName: row.vizserve_pms_forms?.name ?? "",
  }));
}

/** Re-exported so a component can name a row type without two imports. */
export type { BoardTaskRow, TaskListRow };
