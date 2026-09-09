import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { TaskReadClient } from "@/lib/query/fetchers/task";
import {
  fetchPendingRequests,
  fetchTaskBoardView,
  fetchTaskListView,
  type TaskListParams,
} from "@/lib/query/fetchers/task-list";

/**
 * P12-07 — the reads behind `/tasks` and `/tasks/board`.
 *
 * ⚠️ ONE HAPPY CASE PER FETCHER, AND NOTHING ELSE THAT IS GENERIC. The four
 * failure paths — happy, sad, EMPTY, permission — are properties of `read()`,
 * asserted once in `tests/unit/query-layer.test.ts`. Re-asserting them here
 * would be three more copies of the same three lines and would say nothing new
 * about these two pages. `tests/unit/task-fetchers.test.ts` takes the same
 * position and explains it at more length.
 *
 * WHAT IS SURFACE-SPECIFIC, and therefore what is worth a test:
 *
 *   1. THE SORT MAPPING. `?sort=` is a string somebody can type. It goes through
 *      a literal `ORDER_COLUMN` record, and an unrecognised value falls back to
 *      the default rather than reaching Postgres as `invalid input value` and
 *      500ing the page. Nothing else in the file is user input.
 *   2. `is_mine` IS A BOOLEAN. This is the P9-05 bug's guard on the fetcher
 *      side: the filter that replaced it must send one value, never a list.
 *      `tests/unit/task-filters.test.ts` guards the source of the callers; this
 *      guards what the call actually sends.
 *   3. THE SECOND WAVE IS KEYED ON THE FIRST'S IDS, and does not go out at all
 *      when there are none. Six round trips for six guaranteed empty answers is
 *      the shape of an N+1 that only shows up on an empty list.
 *   4. THE BOARD'S TIE-BREAK. `due_date` alone is not a total order and most
 *      cards have none, so undated cards could swap places between renders.
 *
 * No mocking framework, and there must not be one: every fetcher takes its
 * client as an argument, so the object literal below is a complete double.
 */

const DEPT = "cccccccc-0000-4000-8000-000000000003";
const USER = "dddddddd-0000-4000-8000-000000000004";
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const CHILD = "aaaaaaaa-0000-4000-8000-000000000002";
const LIST = "44444444-0000-4000-8000-000000000014";

type Answer = { data: unknown; error: PostgrestError | null };

/** What the stub recorded, so a test can assert WHICH query was issued. */
type Recorded = {
  table?: string;
  rpc?: string;
  args?: unknown;
  select?: string;
  /** `[method, column, value]` — `eq`, `in`, `is` and `not` all land here. */
  filters: [string, string, unknown][];
  /** `"due_date:asc"`, in the order they were chained. */
  order: string[];
  limit?: number;
};

/**
 * A PostgREST-shaped stub.
 *
 * ⚠️ THE BUILDER IS A THENABLE, NOT A PROMISE, because that is what the real one
 * is — `.then()` is what fires the request, which is why `read()` accepts a
 * `PromiseLike`. A stub returning a plain promise from `.select()` would pass
 * these tests and fail against the library.
 *
 * ⚠️ AND EACH CALL RECORDS ITSELF IN ORDER, which is what lets a test say "the
 * second wave asked about the ids the first wave returned" rather than merely
 * "six queries happened".
 */
function stubClient(answers: { tables?: Record<string, Answer[] | Answer>; rpcs?: Record<string, Answer> }): {
  client: TaskReadClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  /* A table can be asked twice with different answers — `vizserve_pms_tasks` is
     the rows, then the subtasks. An array is consumed in order; a single answer
     is given every time. */
  const queues = new Map<string, Answer[]>();

  function answerFor(table: string): Answer {
    const configured = answers.tables?.[table];
    if (Array.isArray(configured)) {
      const queue = queues.get(table) ?? [...configured];
      queues.set(table, queue);
      return queue.shift() ?? { data: [], error: null };
    }
    return configured ?? { data: [], error: null };
  }

  type Builder = PromiseLike<Answer> & {
    select: (columns: string) => Builder;
    eq: (column: string, value: unknown) => Builder;
    in: (column: string, value: unknown) => Builder;
    is: (column: string, value: unknown) => Builder;
    not: (column: string, operator: string, value: unknown) => Builder;
    order: (column: string, options?: { ascending?: boolean }) => Builder;
    limit: (count: number) => Builder;
  };

  const build = (call: Recorded, answer: Answer): Builder => {
    const settled = Promise.resolve(answer);
    const builder: Builder = {
      select(columns) {
        call.select = columns;
        return builder;
      },
      eq(column, value) {
        call.filters.push(["eq", column, value]);
        return builder;
      },
      in(column, value) {
        call.filters.push(["in", column, value]);
        return builder;
      },
      is(column, value) {
        call.filters.push(["is", column, value]);
        return builder;
      },
      not(column, operator, value) {
        call.filters.push(["not", column, `${operator} ${String(value)}`]);
        return builder;
      },
      order(column, options) {
        call.order.push(`${column}:${options?.ascending === false ? "desc" : "asc"}`);
        return builder;
      },
      limit(count) {
        call.limit = count;
        return builder;
      },
      then(onfulfilled, onrejected) {
        return settled.then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      const call: Recorded = { table, filters: [], order: [] };
      calls.push(call);
      return build(call, answerFor(table));
    },
    rpc(fn: string, args?: unknown) {
      const call: Recorded = { rpc: fn, args, filters: [], order: [] };
      calls.push(call);
      return Promise.resolve(answers.rpcs?.[fn] ?? { data: [], error: null });
    },
  };

  // ⚠️ CAST ONCE, AT THE BOUNDARY, AND ONLY IN THE TEST. The fetchers take
  // `Pick<SupabaseClient<Database>, "from" | "rpc">` so production code keeps the
  // generated column types; describing a builder chain structurally would mean
  // hand-copying `PostgrestFilterBuilder`, which drifts on the library's next
  // minor. See the note on `TaskReadClient`.
  return { client: client as unknown as TaskReadClient, calls };
}

const ROW = {
  id: TASK,
  title: "Poster for the open day",
  status: "ONGOING",
  due_date: "2026-09-15",
  start_date: null,
  assignee_id: USER,
  qa_assignee_id: null,
  department_id: DEPT,
  created_by: USER,
  list_id: LIST,
  request_id: null,
  is_personal: false,
  priority: "HIGH",
  estimate_minutes: 240,
  parent_task_id: null,
  resolution: null,
};

const BOARD_ROW = {
  id: TASK,
  title: "Poster for the open day",
  status: "ONGOING",
  due_date: null,
  start_date: null,
  assignee_id: USER,
  qa_assignee_id: null,
  department_id: DEPT,
  created_by: USER,
  request_id: null,
  is_personal: false,
  priority: null,
  output_link: null,
  parent_task_id: null,
  list_id: LIST,
  resolution: null,
};

const PARAMS: TaskListParams = {
  listId: LIST,
  view: "all",
  kind: "all",
  status: null,
  groupId: null,
  priority: null,
  userId: USER,
};

describe("fetchTaskListView", () => {
  it("returns the rows and the six lookups, the second wave keyed on the first's ids", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: [
          { data: [ROW], error: null },
          // The subtask read, which is the same table asked a second question.
          { data: [{ id: CHILD, parent_task_id: TASK, status: "COMPLETED" }], error: null },
        ],
        vizserve_pms_task_comments: {
          data: [
            {
              id: "bbbbbbbb-0000-4000-8000-000000000021",
              task_id: TASK,
              body: "<p>Looks good</p>",
              author_id: USER,
              created_at: "2026-09-05T03:00:00Z",
              updated_at: "2026-09-05T03:00:00Z",
            },
          ],
          error: null,
        },
        vizserve_pms_active_task_coverage: {
          data: [{ task_id: TASK, reliever_id: USER, end_date: "2026-09-12" }],
          error: null,
        },
        vizserve_pms_task_assignees: { data: [{ task_id: TASK, user_id: USER }], error: null },
        vizserve_pms_task_status_history: {
          data: [{ task_id: TASK, to_status: "COMPLETED", created_at: "2026-09-06T03:00:00Z" }],
          error: null,
        },
      },
      rpcs: { vizserve_pms_task_time_tracked: { data: [{ task_id: TASK, minutes: 90 }], error: null } },
    });

    const view = await fetchTaskListView(client, PARAMS);

    expect(view.rows).toHaveLength(1);
    expect(view.comments[0]?.task_id).toBe(TASK);
    expect(view.children[0]?.parent_task_id).toBe(TASK);
    expect(view.tracked[0]?.minutes).toBe(90);
    expect(view.coverage[0]?.reliever_id).toBe(USER);
    expect(view.assignees[0]?.user_id).toBe(USER);
    expect(view.closed[0]?.to_status).toBe("COMPLETED");

    /*
     * ⚠️ THE SECOND WAVE ASKS ABOUT THE IDS THE FIRST RETURNED, which is the
     * whole reason the rows and their lookups share one key: these are not
     * independent facts about a list, they are facts about THIS result set.
     */
    const commentCall = calls.find((call) => call.table === "vizserve_pms_task_comments");
    expect(commentCall?.filters).toContainEqual(["in", "task_id", [TASK]]);
    // The rollup takes the same set, and it is a SECURITY DEFINER function
    // because a member summing the timesheet table would see only their own
    // hours and read them as the task total.
    expect(calls.find((call) => call.rpc)?.args).toEqual({ p_task_ids: [TASK] });
  });

  it("issues no second wave at all when the filters matched nothing", async () => {
    // Six round trips for six guaranteed empty answers. `[]` here is a real
    // empty — the row query above either threw or came back with no rows.
    const { client, calls } = stubClient({
      tables: { vizserve_pms_tasks: { data: [], error: null } },
    });

    const view = await fetchTaskListView(client, PARAMS);

    expect(view.rows).toEqual([]);
    expect(view.comments).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("maps ?sort= through a literal record and falls back on anything else", async () => {
    /*
     * ⚠️ THE ONE PIECE OF USER INPUT IN THE QUERY. `.order(params.sort)` would
     * send an unknown column straight to Postgres, which answers `invalid input
     * value` and 500s the page. The fallback is the default order, which is what
     * the URL asking for nothing gets.
     */
    const bogus = stubClient({ tables: { vizserve_pms_tasks: { data: [], error: null } } });
    await fetchTaskListView(bogus.client, { ...PARAMS, sort: "; drop table", dir: "desc" });
    expect(bogus.calls[0]?.order).toEqual(["due_date:asc", "created_at:desc"]);

    // A recognised key maps to its column and obeys `?dir=`. Priority is a
    // Postgres enum declared LOW → HIGH, so `desc` is highest-first with no
    // CASE and no lookup table.
    const real = stubClient({ tables: { vizserve_pms_tasks: { data: [], error: null } } });
    await fetchTaskListView(real.client, { ...PARAMS, sort: "priority", dir: "desc" });
    expect(real.calls[0]?.order).toEqual(["priority:desc", "created_at:desc"]);

    // And an explicit sort with no `?dir=` is ascending — the table leaves `asc`
    // out of the URL, so reading the direction off the column name is what made
    // Priority unsortable ascending at all (P7-65).
    const asc = stubClient({ tables: { vizserve_pms_tasks: { data: [], error: null } } });
    await fetchTaskListView(asc.client, { ...PARAMS, sort: "estimate" });
    expect(asc.calls[0]?.order).toEqual(["estimate_minutes:asc", "created_at:desc"]);
  });

  it("asks for Mine with a boolean, never a list of ids", async () => {
    /*
     * ⚠️ THE P9-05 BUG, GUARDED ON THE CALL SIDE. `mineFilter` built an `or(...)`
     * holding every joined task id — 16,542 characters for a user with 444 of
     * them, which `fetch` refused with no status and no message, and which
     * `data ?? []` rendered as an empty board. `is_mine` is a computed column
     * answered in Postgres. `tests/unit/task-filters.test.ts` guards the callers'
     * SOURCE; this guards what the call sends.
     */
    const { client, calls } = stubClient({
      tables: { vizserve_pms_tasks: { data: [], error: null } },
    });

    await fetchTaskListView(client, { ...PARAMS, view: "mine" });

    const mine = calls[0]?.filters.find(([, column]) => column === "is_mine");
    expect(mine).toEqual(["eq", "is_mine", true]);
    for (const [, , value] of calls[0]?.filters ?? []) {
      expect(Array.isArray(value)).toBe(false);
    }
  });
});

describe("fetchTaskBoardView", () => {
  it("breaks the due-date tie on created_at, in both card queries", async () => {
    /*
     * ⚠️ THE FIX P12-07 CAME FOR. `due_date` alone is not a total order and most
     * cards have none, so Postgres was free to return the undated majority of a
     * column in a different order on every read — cards shuffling themselves
     * whenever anything refetched, which is now every write rather than every
     * navigation. `/tasks` has ordered by `created_at desc` behind its sort since
     * it was built.
     */
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: [
          { data: [BOARD_ROW], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ],
        vizserve_pms_task_assignees: { data: [{ task_id: TASK, user_id: USER }], error: null },
      },
    });

    const board = await fetchTaskBoardView(client, {
      listId: LIST,
      view: "all",
      kind: "all",
      userId: USER,
    });

    expect(board.live).toHaveLength(1);
    // The seat comes from the join rows for the cards on screen now, not from
    // the server-only "every task this person is on" read.
    expect(board.assignees[0]?.user_id).toBe(USER);

    expect(calls[0]?.order).toEqual(["due_date:asc", "created_at:desc"]);
    // The finished columns are ordered by RECENCY and capped, and they get the
    // same tie-break: two rows written by one statement share `updated_at`.
    expect(calls[1]?.order).toEqual(["updated_at:desc", "created_at:desc"]);
    // A cap without a stated limit is a lie about the number, so the query asks
    // for more than it draws — one over twice the per-column cap, because the
    // rows feed both terminal columns.
    expect(calls[1]?.limit).toBe(25);
  });
});

describe("fetchPendingRequests", () => {
  it("issues nothing where a request cannot answer the page's filters", async () => {
    /*
     * A request has no status, no priority, no assignee and no QA reviewer, so a
     * view asking any of those questions drops them — `pendingRequestsApply` is
     * the pure, unit-tested rule and this fetcher obeys it rather than restating
     * it. Belt and braces beside the caller's `enabled`: a query that ran anyway
     * must not return rows the page has decided not to show.
     */
    const { client, calls } = stubClient({});

    await expect(
      fetchPendingRequests(client, { listId: null, kind: "internal", scope: "all" }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("filters to one list THROUGH the form's inbox list, oldest first", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_requests: {
          data: [
            {
              id: "eeeeeeee-0000-4000-8000-000000000031",
              reference_no: "REQ-2026-0042",
              title: "Open day poster",
              requester_name: "Marie",
              requester_org: "St Anne's",
              target_date: "2026-09-20",
              submitted_at: "2026-08-30T01:00:00Z",
              vizserve_pms_forms: { name: "Design request", default_list_id: LIST },
            },
          ],
          error: null,
        },
      },
    });

    const requests = await fetchPendingRequests(client, {
      listId: LIST,
      kind: "all",
      scope: "all",
    });

    // The form's inbox list is where this request's task will land, so filtering
    // the page to one list filters these to the requests destined for it.
    expect(requests[0]?.listId).toBe(LIST);
    expect(calls[0]?.filters).toContainEqual([
      "eq",
      "vizserve_pms_forms.default_list_id",
      LIST,
    ]);
    // OLDEST FIRST, deliberately the opposite of the task list: the failure mode
    // of a review queue is a request nobody looked at.
    expect(calls[0]?.order).toEqual(["submitted_at:asc"]);
  });
});
