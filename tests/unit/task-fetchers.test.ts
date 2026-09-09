import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  fetchDirectory,
  fetchSubtasks,
  fetchTaskAttachments,
  fetchTaskComments,
  fetchTaskDetail,
  fetchTaskHistory,
  fetchTaskRequest,
  fetchTaskTimeTracked,
  fetchVisibleLists,
  type TaskReadClient,
} from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import { ReadError } from "@/lib/query/read";
import { invalidateTaskPart, invalidateTaskWrite, type Invalidator } from "@/lib/query/invalidate";

/**
 * P12-06 — the reads behind `/tasks/[id]`.
 *
 * ⚠️ ONE HAPPY CASE PER FETCHER, AND NOTHING ELSE THAT IS GENERIC. The four
 * failure paths — happy, sad, EMPTY, permission — are properties of `read()` and
 * `fromAction()`, and they are asserted once in `tests/unit/query-layer.test.ts`.
 * Re-asserting them per domain would be nine copies of the same three lines and
 * would say nothing new about this page. `tests/unit/sidebar-snapshot.test.ts`
 * takes the same position for the same reason.
 *
 * WHAT IS DETAIL-PAGE-SPECIFIC, and therefore what is actually worth a test:
 *
 *   1. The BRIEF is tolerant of its own failure and the rest of the task is not.
 *      That exception is the one place in the fetcher file where a read does not
 *      throw, and it exists because the SECURITY DEFINER function deploys
 *      separately from this code. If it ever starts throwing, the whole page
 *      goes down on a live day for a panel most readers cannot see anyway.
 *   2. The TASK ROW coming back null is a sentence, not a blank page. The server
 *      404s anything RLS hides before this runs, so a null here means the row
 *      went away underneath somebody.
 *   3. HISTORY AND DECISIONS SHARE ONE KEY and one fetcher. They are matched on
 *      a shared timestamp in the page, so arriving apart is a silent miss.
 *   4. THE DECISIONS HALF IS SKIPPED on internal work — there is no client to
 *      have decided anything, and issuing the query would be a round trip for a
 *      guaranteed empty result.
 *   5. A COMMENT INVALIDATES THE COMMENTS AND NOT THE TASK. That is the whole
 *      claim of the split, and it is one assertion.
 *
 * No mocking framework, and there must not be one: every fetcher takes its
 * client as an argument, so the object literal below is a complete double.
 */

const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const REQUEST = "bbbbbbbb-0000-4000-8000-000000000002";
const DEPT = "cccccccc-0000-4000-8000-000000000003";
const USER = "dddddddd-0000-4000-8000-000000000004";

/** The shape PostgREST puts in `error`. Cast, as `query-layer.test.ts` does. */
function pgError(code: string, message: string): PostgrestError {
  return {
    name: "PostgrestError",
    message,
    details: "",
    hint: "",
    code,
  } as unknown as PostgrestError;
}

type Answer = { data: unknown; error: PostgrestError | null };

/** What the stub recorded, so a test can assert WHICH query was issued. */
type Recorded = {
  table?: string;
  rpc?: string;
  args?: unknown;
  select?: string;
  filters: [string, unknown][];
  order: string[];
  maybeSingle: boolean;
};

/**
 * A PostgREST-shaped stub.
 *
 * ⚠️ THE BUILDER IS A THENABLE, NOT A PROMISE, because that is what the real one
 * is — `.then()` is what fires the request, which is why `read()` accepts a
 * `PromiseLike` rather than a `Promise`. A stub that returned a plain promise
 * from `.select()` would pass these tests and fail against the library.
 */
function stubClient(answers: {
  tables?: Record<string, Answer>;
  rpcs?: Record<string, Answer>;
}): { client: TaskReadClient; calls: Recorded[] } {
  const calls: Recorded[] = [];

  type Builder = PromiseLike<Answer> & {
    select: (columns: string) => Builder;
    eq: (column: string, value: unknown) => Builder;
    order: (column: string, options?: { ascending?: boolean }) => Builder;
    maybeSingle: () => PromiseLike<Answer>;
  };

  const build = (call: Recorded, answer: Answer): Builder => {
    const settled = Promise.resolve(answer);
    const builder: Builder = {
      select(columns) {
        call.select = columns;
        return builder;
      },
      eq(column, value) {
        call.filters.push([column, value]);
        return builder;
      },
      order(column) {
        call.order.push(column);
        return builder;
      },
      maybeSingle() {
        call.maybeSingle = true;
        return settled;
      },
      then(onfulfilled, onrejected) {
        return settled.then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      const call: Recorded = { table, filters: [], order: [], maybeSingle: false };
      calls.push(call);
      return build(call, answers.tables?.[table] ?? { data: [], error: null });
    },
    rpc(fn: string, args?: unknown) {
      const call: Recorded = { rpc: fn, args, filters: [], order: [], maybeSingle: false };
      calls.push(call);
      return Promise.resolve(answers.rpcs?.[fn] ?? { data: null, error: null });
    },
  };

  // ⚠️ CAST ONCE, AT THE BOUNDARY, AND ONLY IN THE TEST. The fetchers take
  // `Pick<SupabaseClient<Database>, "from" | "rpc">` so that production code
  // keeps the generated column types; describing a builder chain structurally
  // would mean hand-copying `PostgrestFilterBuilder`, which would drift from
  // the library on its next minor. See the note on `TaskReadClient`.
  return { client: client as unknown as TaskReadClient, calls };
}

const TASK_ROW = {
  id: TASK,
  title: "Poster for the open day",
  description: "<p>Something bright</p>",
  status: "ONGOING",
  resolution: null,
  output_link: null,
  due_date: "2026-09-15",
  start_date: null,
  assignee_id: USER,
  qa_assignee_id: null,
  department_id: DEPT,
  list_id: null,
  request_id: REQUEST,
  is_personal: false,
  priority: "HIGH",
  estimate_minutes: 240,
  field_values: {},
  created_by: USER,
  created_at: "2026-09-01T02:00:00Z",
};

const BRIEF = {
  reference_no: "REQ-2026-0042",
  description: "<p>Something bright, please</p>",
  target_date: "2026-09-20",
  submitted_at: "2026-08-30T01:00:00Z",
};

describe("fetchTaskDetail", () => {
  it("returns the row, the brief and the coverage from one wave", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: { data: TASK_ROW, error: null },
        vizserve_pms_active_task_coverage: {
          data: [{ reliever_id: USER, absent_user_id: USER, end_date: "2026-09-12" }],
          error: null,
        },
      },
      rpcs: { vizserve_pms_task_request_brief: { data: BRIEF, error: null } },
    });

    const detail = await fetchTaskDetail(client, TASK);

    expect(detail.task.title).toBe("Poster for the open day");
    expect(detail.task.priority).toBe("HIGH");
    expect(detail.brief?.reference_no).toBe("REQ-2026-0042");
    // Defaulted by `taskRequestBriefSchema`, not by the caller — a form with no
    // custom fields is every form until somebody adds one.
    expect(detail.brief?.fields).toEqual([]);
    expect(detail.coverage).toHaveLength(1);

    // The brief takes the task id and nothing else, which is why it belongs in
    // this wave rather than in a round trip after it.
    expect(calls.find((call) => call.rpc)?.args).toEqual({ p_task_id: TASK });
  });

  it("keeps the task when the BRIEF function is missing — it deploys separately", async () => {
    /*
     * ⚠️ THE ONE TOLERATED FAILURE IN THE FETCHER FILE. Migrations here are
     * pasted by hand AFTER the code ships, so "the function is not there yet" is
     * a routine state on a live day. Letting it throw would take the title, the
     * status and the dates down with it, over a panel most readers are refused
     * anyway.
     */
    const { client } = stubClient({
      tables: { vizserve_pms_tasks: { data: TASK_ROW, error: null } },
      rpcs: {
        vizserve_pms_task_request_brief: {
          data: null,
          error: pgError("42883", "function vizserve_pms_task_request_brief does not exist"),
        },
      },
    });

    const detail = await fetchTaskDetail(client, TASK);

    expect(detail.task.id).toBe(TASK);
    expect(detail.brief).toBeNull();
  });

  it("says the task is gone rather than rendering an empty one", async () => {
    // The server already 404'd anything RLS hides, so a null here means the row
    // went away while somebody had the page open.
    const { client } = stubClient({
      tables: { vizserve_pms_tasks: { data: null, error: null } },
    });

    await expect(fetchTaskDetail(client, TASK)).rejects.toBeInstanceOf(ReadError);
  });

  it("rejects a row in a shape this build does not recognise", async () => {
    // A column dropped from the `.select()` string, or renamed in a migration,
    // arrives as `undefined` with no type error anywhere. This is the only thing
    // standing between that and an unassigned task with no dates.
    const { client } = stubClient({
      tables: {
        vizserve_pms_tasks: { data: { ...TASK_ROW, status: "NOT_A_STATUS" }, error: null },
      },
    });

    await expect(fetchTaskDetail(client, TASK)).rejects.toBeInstanceOf(ReadError);
  });
});

describe("fetchTaskHistory", () => {
  const ENTRY = {
    id: "eeeeeeee-0000-4000-8000-000000000005",
    from_status: "FOR_CLIENT_APPROVAL",
    to_status: "ONGOING",
    actor_id: null,
    comment: "<p>Can the logo be bigger?</p>",
    is_override: false,
    created_at: "2026-09-05T03:00:00Z",
  };

  const DECISION = {
    id: "ffffffff-0000-4000-8000-000000000006",
    decision: "REVISION_REQUESTED",
    comment: "<p>Can the logo be bigger?</p>",
    approver_name: "Marie at the client",
    created_at: "2026-09-05T03:00:00Z",
  };

  it("returns the trail and the decisions together, under one key", async () => {
    /*
     * ⚠️ ONE FETCHER FOR TWO TABLES IS THE POINT. `vizserve_pms_decide_task`
     * writes both rows in one statement, and the page matches the approver's
     * name onto the history row through the timestamp they share. Split across
     * two keys they could arrive out of step, and the client's own words would
     * render as "The client" instead of as the person who wrote them.
     */
    const { client } = stubClient({
      tables: {
        vizserve_pms_task_status_history: { data: [ENTRY], error: null },
        vizserve_pms_client_decisions: { data: [DECISION], error: null },
      },
    });

    const result = await fetchTaskHistory(client, TASK, { hasRequest: true });

    expect(result.history[0]?.actor_id).toBeNull();
    expect(result.decisions[0]?.approver_name).toBe("Marie at the client");
    // The two share a timestamp because they are the same transaction. This is
    // what the page's `clientNameAt` map is keyed on.
    expect(result.decisions[0]?.created_at).toBe(result.history[0]?.created_at);
  });

  it("does not query decisions on internal work", async () => {
    // There is no client to have decided anything, so the round trip would be a
    // guaranteed empty result.
    const { client, calls } = stubClient({
      tables: { vizserve_pms_task_status_history: { data: [], error: null } },
    });

    const result = await fetchTaskHistory(client, TASK, { hasRequest: false });

    expect(result.decisions).toEqual([]);
    expect(calls.map((call) => call.table)).toEqual(["vizserve_pms_task_status_history"]);
  });
});

describe("the per-panel reads", () => {
  it("fetchTaskComments reads this task's thread, oldest first", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_task_comments: {
          data: [
            {
              id: "11111111-0000-4000-8000-000000000011",
              body: "<p>On it</p>",
              author_id: USER,
              created_at: "2026-09-02T01:00:00Z",
              updated_at: "2026-09-02T01:00:00Z",
            },
          ],
          error: null,
        },
      },
    });

    const comments = await fetchTaskComments(client, TASK);

    expect(comments).toHaveLength(1);
    expect(calls[0]?.filters).toEqual([["task_id", TASK]]);
  });

  it("fetchSubtasks filters on parent_task_id — one task, not a list of them", async () => {
    /*
     * ⚠️ THE READ THE PLAN FLAGS AS NOT SPLITTING CLEANLY, AND THIS IS WHY IT
     * DOES HERE. Elsewhere subtasks arrive `.in("task_id", taskIds)` across
     * eighty rows at once, which no per-task key can own. On the detail page it
     * is one parent.
     */
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: {
          data: [
            {
              id: "22222222-0000-4000-8000-000000000012",
              title: "Draft the copy",
              status: "OPEN",
              due_date: null,
              assignee_id: null,
              priority: null,
            },
          ],
          error: null,
        },
      },
    });

    const subtasks = await fetchSubtasks(client, TASK);

    expect(subtasks[0]?.title).toBe("Draft the copy");
    expect(calls[0]?.filters).toEqual([["parent_task_id", TASK]]);
  });

  it("fetchTaskAttachments returns the output files", async () => {
    const { client } = stubClient({
      tables: {
        vizserve_pms_task_attachments: {
          data: [
            {
              id: "33333333-0000-4000-8000-000000000013",
              filename: "poster-v2.pdf",
              mime_type: "application/pdf",
              size_bytes: 91_234,
              uploaded_by: USER,
            },
          ],
          error: null,
        },
      },
    });

    await expect(fetchTaskAttachments(client, TASK)).resolves.toEqual([
      {
        id: "33333333-0000-4000-8000-000000000013",
        filename: "poster-v2.pdf",
        mime_type: "application/pdf",
        size_bytes: 91_234,
        uploaded_by: USER,
      },
    ]);
  });

  it("fetchTaskTimeTracked picks this task's row out of the set the RPC returns", async () => {
    /*
     * ⚠️ THE RPC TAKES AND RETURNS A SET, because it is the same rollup the list
     * page calls for eighty tasks at once. Reading `[0]` blindly would be wrong
     * the day it is called with more than one id.
     */
    const { client, calls } = stubClient({
      rpcs: {
        vizserve_pms_task_time_tracked: {
          data: [
            { task_id: "99999999-0000-4000-8000-000000000099", minutes: 999 },
            { task_id: TASK, minutes: 315 },
          ],
          error: null,
        },
      },
    });

    await expect(fetchTaskTimeTracked(client, TASK)).resolves.toBe(315);
    expect(calls[0]?.args).toEqual({ p_task_ids: [TASK] });
  });

  it("fetchTaskTimeTracked returns 0 for a task nobody has logged against", async () => {
    // ⚠️ A REAL ZERO, AND IT IS NOT A `?? 0` ON A FAILURE. A task with no hours
    // is simply absent from the rollup's result set; a failed read still throws
    // out of `read()` one line above, which is the distinction that matters.
    const { client } = stubClient({
      rpcs: { vizserve_pms_task_time_tracked: { data: [], error: null } },
    });

    await expect(fetchTaskTimeTracked(client, TASK)).resolves.toBe(0);
  });

  it("fetchVisibleLists asks for every ACTIVE list and no department at all", async () => {
    /*
     * ⚠️ P12-07 WIDENED THIS FROM ONE DEPARTMENT'S LISTS TO EVERY VISIBLE ONE,
     * and the two halves of that are both asserted here because both are load
     * bearing. THE ROWS: no `department_id` filter, because `/tasks` needs the
     * lists of every department the reader can see and a department-keyed entry
     * could not hold them — the detail page filters this set in the browser
     * instead. THE COLUMNS: `group_id`, `owner_id` and `department_id` ride
     * along for the folder filter, the P11-06 personal-list split and that
     * filter respectively.
     *
     * `is_active` STAYS. Dropping it would put archived lists in the filter
     * dropdown and a stale name in the breadcrumb, both of which `/tasks`
     * documents as deliberate.
     */
    const LIST = {
      id: "44444444-0000-4000-8000-000000000014",
      name: "Collateral",
      group_id: null,
      owner_id: null,
      department_id: DEPT,
    };
    const { client, calls } = stubClient({
      tables: { vizserve_pms_lists: { data: [LIST], error: null } },
    });

    await expect(fetchVisibleLists(client)).resolves.toEqual([LIST]);
    // `lists readable in department scope` is what decides visibility, and
    // restating it here would imply the policy is optional.
    expect(calls[0]?.filters).toEqual([["is_active", true]]);
    expect(calls[0]?.select).toContain("department_id");
  });

  it("fetchDirectory keeps the people who have LEFT, with the flag to tell them apart", async () => {
    /*
     * ⚠️ THE `is_active = true` FILTER CAME OFF IN P12-07 AND THAT IS THE TEST.
     * The people who leave are exactly the people whose old comments and history
     * rows still need a name: filtered to the active, a deactivated colleague's
     * comment renders as "Someone no longer active" while the row beside it,
     * read from a different entry, still names them. Every consumer that offers
     * somebody a SEAT filters on the column itself — and must, because each
     * narrows by department in the same pass.
     */
    const GONE = {
      id: "99999999-0000-4000-8000-000000000019",
      full_name: "Someone Who Left",
      primary_department_id: DEPT,
      is_active: false,
    };
    const HERE = {
      id: USER,
      full_name: "Ace Guevarra",
      primary_department_id: DEPT,
      is_active: true,
    };
    const { client, calls } = stubClient({
      tables: { vizserve_pms_users: { data: [HERE, GONE], error: null } },
    });

    await expect(fetchDirectory(client)).resolves.toEqual([HERE, GONE]);
    expect(calls[0]?.filters).toEqual([]);
  });

  it("fetchTaskRequest returns null where the policy returns no row", async () => {
    /*
     * ⚠️ THE ORDINARY CASE, NOT A FAILURE. `requests readable in department
     * scope` returns no row to a member PIC, deliberately — the client is never
     * told who at VizServe holds their task, and the anonymity runs both ways.
     * Null means "you may not see who asked", never "nobody asked".
     */
    const { client } = stubClient({
      tables: { vizserve_pms_requests: { data: null, error: null } },
    });

    await expect(fetchTaskRequest(client, REQUEST)).resolves.toBeNull();
  });
});

/**
 * The claim the whole split exists to make, as one assertion each way.
 */
describe("what a task write invalidates", () => {
  /**
   * ⚠️ THE STUB NEVER SETTLES BY ITSELF, WHICH IS WHAT MAKES "AWAITED" TESTABLE.
   *
   * P12-08 split these helpers into keys the caller WAITS for and keys it merely
   * fires, and the difference is invisible to a recorder whose promises are
   * already resolved. Each call here parks its promise in `settle`, so a test can
   * see which invalidations the helper is still holding its transition open for —
   * and that is the half `ded2244` turns on.
   */
  function recorder() {
    const calls: unknown[][] = [];
    const settle: (() => void)[] = [];
    const client: Invalidator = {
      invalidateQueries: ({ queryKey }) => {
        calls.push([...queryKey]);
        return new Promise<void>((resolve) => settle.push(resolve));
      },
    };
    /** Let every outstanding invalidation land. */
    const finish = () => {
      for (const resolve of settle.splice(0)) resolve();
    };
    return { client, calls, finish };
  }

  it("a comment refetches the comments and NOT the task", async () => {
    const { client, calls, finish } = recorder();
    const done = invalidateTaskPart(client, TASK, "comments", [qk.tasks()]);
    finish();
    await done;

    expect(calls).toEqual([[...qk.taskPart(TASK, "comments")], [...qk.tasks()]]);
    // ⚠️ THE NEGATIVE HALF IS THE POINT. `["task", id]` would prefix-match the
    // comments key AND the other five panels, so asserting only what WAS called
    // would pass on an implementation that swept the whole task.
    expect(calls).not.toContainEqual([...qk.task(TASK)]);
  });

  it("a status move sweeps the task, the list views and the rail", async () => {
    const { client, calls, finish } = recorder();
    const done = invalidateTaskWrite(client, TASK);
    finish();
    await done;

    // `qk.task(id)` prefix-matches every panel, which is right here: a move
    // writes a history row and changes the counts in the rail. All three are
    // invalidated; the rail is simply not waited for — see below.
    expect(calls).toEqual([[...qk.snapshot()], [...qk.task(TASK)], [...qk.tasks()]]);
  });

  it("does not hold the caller open for the RAIL, only for the surfaces", async () => {
    /*
     * ⚠️ P12-08, AND IT IS THE HALF A RECORDER USUALLY CANNOT SEE. What must be
     * awaited is only what an optimistic value is standing in for: the task and
     * the list/board views. Awaiting an UNOBSERVED key is free — `invalidateQueries`
     * refetches only what a mounted component is watching — so awaiting both
     * surfaces costs whichever one the reader is actually on. `qk.snapshot()` is
     * the exception: the rail is mounted on every page in the product and its
     * refetch is a whole-tree aggregate, and it has no optimistic value that
     * could revert while it catches up. So it is fired, not waited for.
     */
    const { client, finish } = recorder();

    let settled = false;
    const done = invalidateTaskWrite(client, TASK).then(() => {
      settled = true;
    });

    // Nothing has landed yet, so nothing may have resolved.
    await Promise.resolve();
    expect(settled).toBe(false);

    finish();
    await done;
    expect(settled).toBe(true);
  });

  it("waits for everything when a caller asks it to", async () => {
    // The pre-P12-08 behaviour, kept for a caller that genuinely cannot proceed
    // until the counts are right. There is none today, and adding one should
    // come with a reason at the call site.
    const { client, calls, finish } = recorder();
    const done = invalidateTaskWrite(client, TASK, { wait: "everything" });
    finish();
    await done;

    expect(calls).toEqual([[...qk.task(TASK)], [...qk.tasks()], [...qk.snapshot()]]);
  });

  it("a task created with no parent names no task key at all", async () => {
    const { client, calls, finish } = recorder();
    const done = invalidateTaskWrite(client);
    finish();
    await done;

    expect(calls).toEqual([[...qk.snapshot()], [...qk.tasks()]]);
  });
});
