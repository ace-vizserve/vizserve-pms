import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { TaskReadClient } from "@/lib/query/fetchers/task";
import { fetchManagedLists } from "@/lib/query/fetchers/lists";
import { fetchInbox, fetchUnreadCount } from "@/lib/query/fetchers/inbox";
import {
  fetchRequestDetail,
  fetchRequestOutcome,
  fetchRequestsPage,
} from "@/lib/query/fetchers/requests";
import {
  fetchApprovalsQueue,
  fetchHandoverTasks,
  type ApprovalsReadClient,
} from "@/lib/query/fetchers/approvals";
import { qk } from "@/lib/query/keys";
import { ReadError } from "@/lib/query/read";
import type { ApprovalsViewer } from "@/lib/schemas/internal-approvals";

/**
 * P12-16 … P12-19 — the reads behind lists, the inbox, requests and approvals.
 *
 * ⚠️ ONE HAPPY CASE PER FETCHER, AND NOTHING ELSE THAT IS GENERIC. The four
 * failure paths — happy, sad, EMPTY, permission — are properties of `read()` and
 * `fromAction()`, and they are asserted once in `tests/unit/query-layer.test.ts`.
 * Re-asserting them per domain would be a dozen copies of the same three lines.
 * `task-fetchers.test.ts` takes the same position for the same reason and says
 * so at greater length.
 *
 * WHAT IS PHASE-4-SPECIFIC, and therefore what is actually worth a test:
 *
 *   1. `/tasks/lists` DOES NOT FILTER `is_active` and DOES filter
 *      `owner_id is null`. Both are load-bearing in opposite directions: this is
 *      the only screen that can un-archive a list, and a personal list appearing
 *      in a department's tree is the standing P11-06 regression.
 *   2. THE OPEN COUNT IS TALLIED IN THE BROWSER over a column selected for every
 *      open task. It is the one derivation in that fetcher.
 *   3. THE INBOX'S UNREAD COUNT IS A SEPARATE QUERY over the whole table, not a
 *      tally of the page. Deriving it from the rows reported "3 unread" meaning
 *      "3 on this page" once already.
 *   4. `qk.request(id)` IS THE WIDENED SUPERSET. `/tasks/[id]` and
 *      `/requests/[id]` share the entry, so the select must carry the columns
 *      BOTH read — a narrowing here is the silent whichever-ran-last-wins bug
 *      `fetchDepartmentLists` warned about.
 *   5. THE OUTCOME READ IS SKIPPED ON A PENDING REQUEST — asserted through its
 *      `names` behaviour, since a decided request with no people resolves none.
 *   6. `waitingOnMe` NARROWS THE APPROVER QUEUE, and it narrows it AFTER the
 *      query rather than through a `.limit()`. A queue that silently shortens is
 *      the failure `lib/approvals-queue.ts` was extracted to stop.
 *   7. `fetchHandoverTasks` PUTS NOTHING VARIABLE-LENGTH IN A FILTER. That is
 *      the whole of P9-01's 16,542-character URL bug, and it is one assertion.
 *
 * No mocking framework, and there must not be one: every fetcher takes its
 * client as an argument, so the object literal below is a complete double.
 */

const USER = "dddddddd-0000-4000-8000-000000000004";
const DEPT = "cccccccc-0000-4000-8000-000000000003";
const REQUEST = "bbbbbbbb-0000-4000-8000-000000000002";
const LIST_A = "11111111-0000-4000-8000-000000000001";
const LIST_B = "11111111-0000-4000-8000-000000000002";
const GROUP = "22222222-0000-4000-8000-000000000001";
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "eeeeeeee-0000-4000-8000-000000000005";

function pgError(code: string, message: string): PostgrestError {
  return {
    name: "PostgrestError",
    message,
    details: "",
    hint: "",
    code,
  } as unknown as PostgrestError;
}

type Answer = { data: unknown; error: PostgrestError | null; count?: number | null };

/** What the stub recorded, so a test can assert WHICH query was issued. */
type Recorded = {
  table?: string;
  rpc?: string;
  args?: unknown;
  select?: string;
  filters: [string, string, unknown][];
  order: string[];
  range?: [number, number];
  limit?: number;
  maybeSingle: boolean;
};

/**
 * A PostgREST-shaped stub, widened from `task-fetchers.test.ts`'s for the four
 * builder methods Phase 4 uses that Phase 3 did not: `.is`, `.not`, `.in`,
 * `.range`, `.limit`, `.neq` and `.or`.
 *
 * ⚠️ THE BUILDER IS A THENABLE, NOT A PROMISE, because that is what the real one
 * is — `.then()` is what fires the request, which is why `read()` accepts a
 * `PromiseLike`. A stub returning a plain promise from `.select()` would pass
 * these tests and fail against the library.
 */
function stubClient(answers: {
  tables?: Record<string, Answer>;
  rpcs?: Record<string, Answer>;
}): { client: TaskReadClient & ApprovalsReadClient; calls: Recorded[] } {
  const calls: Recorded[] = [];

  const build = (call: Recorded, answer: Answer) => {
    const settled = Promise.resolve(answer);
    const filter = (op: string) => (column: string, ...rest: unknown[]) => {
      call.filters.push([op, column, rest.length === 1 ? rest[0] : rest]);
      return builder;
    };
    const builder: Record<string, unknown> = {
      select(columns: string) {
        call.select = columns;
        return builder;
      },
      eq: filter("eq"),
      neq: filter("neq"),
      is: filter("is"),
      not: filter("not"),
      in: filter("in"),
      gte: filter("gte"),
      lt: filter("lt"),
      or(expression: string) {
        call.filters.push(["or", expression, null]);
        return builder;
      },
      order(column: string) {
        call.order.push(column);
        return builder;
      },
      range(from: number, to: number) {
        call.range = [from, to];
        return builder;
      },
      limit(n: number) {
        call.limit = n;
        return builder;
      },
      maybeSingle() {
        call.maybeSingle = true;
        return settled;
      },
      then(onfulfilled: unknown, onrejected: unknown) {
        return settled.then(
          onfulfilled as never,
          onrejected as never,
        );
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      const call: Recorded = { table, filters: [], order: [], maybeSingle: false };
      calls.push(call);
      return build(call, answers.tables?.[table] ?? { data: [], error: null, count: 0 });
    },
    rpc(fn: string, args?: unknown) {
      const call: Recorded = { rpc: fn, args, filters: [], order: [], maybeSingle: false };
      calls.push(call);
      return Promise.resolve(answers.rpcs?.[fn] ?? { data: [], error: null });
    },
  };

  /* ⚠️ CAST ONCE, AT THE BOUNDARY, AND ONLY IN THE TEST. The fetchers keep the
     generated column types in production; describing a builder chain
     structurally would mean hand-copying `PostgrestFilterBuilder`, which would
     drift from the library on its next minor. */
  return { client: client as unknown as TaskReadClient & ApprovalsReadClient, calls };
}

const found = (calls: Recorded[], table: string) => calls.filter((call) => call.table === table);
const hasFilter = (call: Recorded | undefined, op: string, column: string) =>
  Boolean(call?.filters.some(([o, c]) => o === op && c === column));

/* -------------------------------------------------------------------------- */
/* P12-16 — /tasks/lists                                                       */
/* -------------------------------------------------------------------------- */

const LIST_ROW = {
  id: LIST_A,
  name: "Open day",
  description: "",
  department_id: DEPT,
  is_active: true,
  sort_order: 0,
  group_id: GROUP,
  form_id: null,
};

const GROUP_ROW = {
  id: GROUP,
  name: "Client Requests",
  description: "",
  department_id: DEPT,
  is_active: true,
  sort_order: 1000,
  is_system: true,
};

describe("fetchManagedLists", () => {
  it("keeps archived rows and drops personal ones", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_lists: {
          data: [LIST_ROW, { ...LIST_ROW, id: LIST_B, name: "Archived", is_active: false }],
          error: null,
        },
        vizserve_pms_task_groups: { data: [GROUP_ROW], error: null },
        vizserve_pms_tasks: { data: [], error: null },
      },
    });

    const tree = await fetchManagedLists(client);

    /* ⚠️ NO `is_active` FILTER ON EITHER. This is the only screen from which an
       archived list or folder is brought back, so filtering here would make that
       impossible from the one place it is offered. */
    expect(hasFilter(found(calls, "vizserve_pms_lists")[0], "eq", "is_active")).toBe(false);
    expect(hasFilter(found(calls, "vizserve_pms_task_groups")[0], "eq", "is_active")).toBe(false);

    /* ⚠️ P11-06, AND NOT REDUNDANT WITH RLS. The policy lets the caller read
       their OWN personal lists, so without this a lead would find their private
       lists in their department's tree, offered a folder picker the check
       constraint refuses. */
    expect(hasFilter(found(calls, "vizserve_pms_lists")[0], "is", "owner_id")).toBe(true);

    expect(tree.lists.map((list) => list.is_active)).toEqual([true, false]);
    expect(tree.groups).toHaveLength(1);
  });

  it("tallies the open count per list and ignores unfiled tasks", async () => {
    const { client } = stubClient({
      tables: {
        vizserve_pms_lists: { data: [LIST_ROW], error: null },
        vizserve_pms_task_groups: { data: [GROUP_ROW], error: null },
        vizserve_pms_tasks: {
          data: [{ list_id: LIST_A }, { list_id: LIST_A }, { list_id: LIST_B }, { list_id: null }],
          error: null,
        },
      },
    });

    const tree = await fetchManagedLists(client);

    expect(tree.openCounts).toEqual({ [LIST_A]: 2, [LIST_B]: 1 });
  });

  it("throws rather than reporting an empty tree", async () => {
    const { client } = stubClient({
      tables: {
        vizserve_pms_lists: { data: null, error: pgError("42501", "permission denied") },
      },
    });

    await expect(fetchManagedLists(client)).rejects.toBeInstanceOf(ReadError);
  });
});

/* -------------------------------------------------------------------------- */
/* P12-17 — /inbox                                                             */
/* -------------------------------------------------------------------------- */

const NOTIFICATION = {
  id: "33333333-0000-4000-8000-000000000001",
  type: "assigned",
  title: "You were assigned a task",
  body: "<p>Poster</p>",
  link_path: "/tasks/1",
  read_at: null,
  emailed_at: null,
  created_at: "2026-09-01T02:00:00Z",
};

describe("fetchInbox", () => {
  it("returns the page and its total, and obeys the read filter", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_notifications: { data: [NOTIFICATION], error: null, count: 41 },
      },
    });

    const page = await fetchInbox(client, {
      term: "",
      type: null,
      read: "unread",
      page: 2,
      pageSize: 25,
      requestedSort: undefined,
      dir: undefined,
    });

    expect(page.rows).toHaveLength(1);
    /* ⚠️ THE TOTAL IS THE COUNT, NOT THE ROW LENGTH. The page holds one
       `.range()` of a much longer list. */
    expect(page.total).toBe(41);
    expect(found(calls, "vizserve_pms_notifications")[0]?.range).toEqual([25, 49]);

    /* `.is("read_at", null)` rather than `.neq`: SQL null is not equal to
       anything, including itself, so neq would return zero rows for every row. */
    expect(hasFilter(found(calls, "vizserve_pms_notifications")[0], "is", "read_at")).toBe(true);
  });

  it("counts the unread over the whole table, not over the page", async () => {
    const { client, calls } = stubClient({
      tables: { vizserve_pms_notifications: { data: null, error: null, count: 12 } },
    });

    await expect(fetchUnreadCount(client)).resolves.toBe(12);

    /*
     * ⚠️ ONE FILTER AND NO RANGE. The count ignores the search, the type and the
     * page on purpose — "12 unread" beside "4 results" is two different facts,
     * and deriving the first from the rows on screen reported "3 unread" meaning
     * "3 on this page" once already.
     */
    const call = found(calls, "vizserve_pms_notifications")[0];
    expect(call?.range).toBeUndefined();
    expect(call?.filters).toEqual([["is", "read_at", null]]);
  });
});

/* -------------------------------------------------------------------------- */
/* P12-18 — /requests                                                          */
/* -------------------------------------------------------------------------- */

const REQUEST_ROW = {
  id: REQUEST,
  reference_no: "REQ-2026-0042",
  title: "Poster for the open day",
  requester_name: "Dana Cruz",
  requester_org: "Springfield High",
  target_date: "2026-09-20",
  approved_target_date: null,
  sla_started_at: "2026-08-30T01:00:00Z",
  reviewed_by: null,
  status: "PENDING_REVIEW",
  submitted_at: "2026-08-30T01:00:00Z",
  form_id: "44444444-0000-4000-8000-000000000001",
};

describe("fetchRequestsPage", () => {
  it("skips the reviewer query when no row on the page has been decided", async () => {
    const { client, calls } = stubClient({
      tables: { vizserve_pms_requests: { data: [REQUEST_ROW], error: null, count: 1 } },
    });

    const page = await fetchRequestsPage(client, {
      term: "",
      status: null,
      formId: null,
      from: null,
      to: null,
      page: 1,
      pageSize: 25,
      requestedSort: undefined,
      dir: undefined,
    });

    expect(page.total).toBe(1);
    expect(page.reviewerNames).toEqual({});
    /* `reviewed_by` is null on every pending row, so a join would widen the hot
       query to answer a question only the decided rows ask. */
    expect(found(calls, "vizserve_pms_users")).toHaveLength(0);
  });

  it("resolves the reviewers on the page, once", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_requests: {
          data: [
            { ...REQUEST_ROW, status: "APPROVED", reviewed_by: USER },
            { ...REQUEST_ROW, id: OTHER, status: "APPROVED", reviewed_by: USER },
          ],
          error: null,
          count: 2,
        },
        vizserve_pms_users: { data: [{ id: USER, full_name: "Ace Guevarra" }], error: null },
      },
    });

    const page = await fetchRequestsPage(client, {
      term: "",
      status: null,
      formId: null,
      from: null,
      to: null,
      page: 1,
      pageSize: 25,
      requestedSort: undefined,
      dir: undefined,
    });

    expect(page.reviewerNames).toEqual({ [USER]: "Ace Guevarra" });
    // One `in` query, deduped — not one per row.
    expect(found(calls, "vizserve_pms_users")).toHaveLength(1);
  });
});

describe("fetchRequestDetail — the widened superset", () => {
  /**
   * ⚠️ THE COLUMNS BOTH CONSUMERS READ. `qk.request(id)` is written by
   * `/requests/[id]` AND by `/tasks/[id]`, so a narrowing here is the silent
   * whichever-ran-last-wins bug `fetchDepartmentLists` warned about: the task
   * page would find `requester_email` undefined, or the request page would find
   * `field_values` gone, depending on which mounted last.
   */
  const BOTH_READ = [
    // The eleven `/tasks/[id]` reads.
    "reference_no",
    "requester_name",
    "requester_email",
    "requester_org",
    "description",
    "target_date",
    "submitted_at",
    "reviewed_by",
    "reviewed_at",
    "form_id",
    // The six `/requests/[id]` adds.
    "title",
    "approved_target_date",
    "field_values",
    "status",
    "decision_reason",
    "sla_started_at",
  ];

  it("selects every column either surface reads", async () => {
    const { client, calls } = stubClient({
      tables: { vizserve_pms_requests: { data: null, error: null } },
    });

    await fetchRequestDetail(client, REQUEST);

    const select = found(calls, "vizserve_pms_requests")[0]?.select ?? "";
    for (const column of BOTH_READ) expect(select).toContain(column);
  });

  it("returns null for a row the policy withholds, rather than throwing", async () => {
    /* Out of scope returns NO ROW under RLS rather than a refusal. On
       `/requests/[id]` the caller turns that into `notFound()`; on `/tasks/[id]`
       it is the ordinary case for a member PIC (P7-59). */
    const { client } = stubClient({
      tables: { vizserve_pms_requests: { data: null, error: null } },
    });

    await expect(fetchRequestDetail(client, REQUEST)).resolves.toBeNull();
  });
});

describe("fetchRequestOutcome", () => {
  it("resolves only the people the card can name", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: {
          data: { id: TASK, title: "Poster", status: "ONGOING", assignee_id: USER, qa_assignee_id: null },
          error: null,
        },
        vizserve_pms_approvals: {
          data: [
            {
              decision: "approved",
              reason: null,
              created_at: "2026-09-02T01:00:00Z",
              approver_id: OTHER,
            },
          ],
          error: null,
        },
        vizserve_pms_users: {
          data: [
            { id: USER, full_name: "Ana Cruz" },
            { id: OTHER, full_name: "Ace Guevarra" },
          ],
          error: null,
        },
      },
    });

    const outcome = await fetchRequestOutcome(client, REQUEST);

    expect(outcome.task?.id).toBe(TASK);
    expect(outcome.names).toEqual({ [USER]: "Ana Cruz", [OTHER]: "Ace Guevarra" });
    /* ⚠️ NOT `qk.ref("users")`. This resolves at most three people on a page
       most readers open once; pulling the whole directory in would trade a
       two-row query for the entire company. One query, three ids. */
    expect(found(calls, "vizserve_pms_users")).toHaveLength(1);
  });

  it("issues no people query when nothing on the card names anybody", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: { data: null, error: null },
        vizserve_pms_approvals: { data: [], error: null },
      },
    });

    const outcome = await fetchRequestOutcome(client, REQUEST);

    expect(outcome.names).toEqual({});
    expect(found(calls, "vizserve_pms_users")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* P12-19 — /approvals                                                         */
/* -------------------------------------------------------------------------- */

const INTERNAL_ROW = {
  id: "55555555-0000-4000-8000-000000000001",
  request_type: "LEAVE",
  requester_id: OTHER,
  department_id: DEPT,
  status: "PENDING_REVIEW",
  reason: "<p>Away</p>",
  start_date: "2026-09-10",
  end_date: "2026-09-11",
  work_date: null,
  correction_at: null,
  amount: null,
  overtime_minutes: null,
  leave_type_id: null,
  start_half: null,
  end_half: null,
  approval_stage: 2,
  turnover_confirmed_at: null,
  decision_reason: null,
  withdrawn_note: null,
  reviewed_by: null,
  reviewed_at: null,
  created_at: "2026-09-01T02:00:00Z",
  updated_at: "2026-09-01T02:00:00Z",
  vizserve_pms_users: { full_name: "Ana Cruz" },
};

const LEAD: ApprovalsViewer = {
  userId: USER,
  role: "team_leader",
  managedDepartmentIds: [DEPT],
  gender: null,
  isApprover: true,
  isAdmin: false,
  hasDepartment: true,
  fullName: "Ace Guevarra",
};

const MEMBER: ApprovalsViewer = {
  ...LEAD,
  role: "member",
  managedDepartmentIds: [],
  isApprover: false,
};

describe("fetchApprovalsQueue", () => {
  it("narrows the approver queue with waitingOnMe, after the query", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_internal_requests: {
          data: [
            INTERNAL_ROW,
            // Stage 1 — still with the relievers, so NOT this lead's to decide,
            // even though the policy lets them read it (P9-04).
            { ...INTERNAL_ROW, id: "55555555-0000-4000-8000-000000000002", approval_stage: 1 },
            // Another department, which `canAccessDepartmentScope` refuses.
            {
              ...INTERNAL_ROW,
              id: "55555555-0000-4000-8000-000000000003",
              department_id: "cccccccc-0000-4000-8000-00000000000f",
            },
          ],
          error: null,
          count: 0,
        },
      },
    });

    const queue = await fetchApprovalsQueue(client, LEAD, {
      page: 1,
      pageSize: 25,
      requestedSort: undefined,
      dir: undefined,
    });

    expect(queue.pendingOnMe.map((row) => row.id)).toEqual([INTERNAL_ROW.id]);

    /*
     * ⚠️ THE CAP IS A `.limit()` ON THE QUERY AND THE NARROWING HAPPENS AFTER
     * IT, WHICH IS THE ORDER THAT MATTERS. Taking the first N and THEN filtering
     * would show three, or none, while others sat below the cut — a queue that
     * silently shortens is the failure `lib/approvals-queue.ts` records.
     */
    const queueCall = found(calls, "vizserve_pms_internal_requests")[1];
    expect(queueCall?.limit).toBe(201);
    expect(hasFilter(queueCall, "neq", "requester_id")).toBe(true);
  });

  it("returns no weeks for a member, and still reads their cover queue", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_internal_requests: { data: [], error: null, count: 0 },
        vizserve_pms_internal_request_relievers: { data: [], error: null },
      },
    });

    const queue = await fetchApprovalsQueue(client, MEMBER, {
      page: 1,
      pageSize: 25,
      requestedSort: undefined,
      dir: undefined,
    });

    expect(queue.weeks).toEqual([]);
    expect(queue.weeksError).toBeNull();
    /* The weeks query is gated on `isApprover` and issues nothing. */
    expect(found(calls, "vizserve_pms_timesheet_weeks")).toHaveLength(0);
    /* ⚠️ THE COVER QUEUE IS NOT GATED, AND MUST NEVER BE. A reliever is usually
       a plain member, and the gate that returns nothing for one is exactly what
       would hide the single decision they are owed. */
    expect(found(calls, "vizserve_pms_internal_request_relievers")).toHaveLength(1);
  });
});

describe("fetchHandoverTasks", () => {
  it("puts nothing variable-length in a filter", async () => {
    const { client, calls } = stubClient({
      tables: {
        vizserve_pms_tasks: {
          data: [{ id: TASK, title: "Poster", created_at: "2026-09-01T02:00:00Z" }],
          error: null,
        },
        vizserve_pms_task_assignees: {
          data: [
            {
              vizserve_pms_tasks: {
                id: OTHER,
                title: "Banner",
                created_at: "2026-09-02T02:00:00Z",
                status: "ONGOING",
              },
            },
            // The SAME task reached both ways. Somebody is routinely the PIC and
            // carries a `task_assignees` row for the same work.
            {
              vizserve_pms_tasks: {
                id: TASK,
                title: "Poster",
                created_at: "2026-09-01T02:00:00Z",
                status: "ONGOING",
              },
            },
          ],
          error: null,
        },
      },
    });

    const { tasks, error } = await fetchHandoverTasks(client, USER);

    expect(error).toBeNull();
    // Merged, and newest first.
    expect(tasks.map((task) => task.id)).toEqual([OTHER, TASK]);

    /*
     * ⚠️ THE WHOLE OF P9-01's BUG, IN ONE ASSERTION. The first version built an
     * `or(...)` holding every joined task id — 444 of them for one real user,
     * a 16,542-character URL that `fetch` refused with no status and no
     * PostgREST message. Both filters below carry ONE uuid whatever the
     * person's history looks like, and the join table is reached through an
     * `!inner` embed rather than by listing its ids.
     */
    for (const call of calls) {
      for (const [, value] of call.filters.map(([op, column, rest]) => [op, `${column}${rest}`])) {
        expect(String(value).length).toBeLessThan(200);
      }
    }
    expect(found(calls, "vizserve_pms_task_assignees")[0]?.select).toContain("!inner");
  });

  it("returns its error rather than an empty list", async () => {
    /* An empty list here is a SENTENCE telling somebody they have no work to
       hand over, which is the wrong zero this phase exists to remove. It does
       not throw, because a failed task scan must not take down somebody's
       approval queue — the dialog says which it was. */
    const { client } = stubClient({
      tables: {
        vizserve_pms_tasks: { data: null, error: pgError("42501", "permission denied") },
        vizserve_pms_task_assignees: { data: [], error: null },
      },
    });

    const { tasks, error } = await fetchHandoverTasks(client, USER);

    expect(tasks).toEqual([]);
    expect(error?.message).toBe("permission denied");
  });
});

/* -------------------------------------------------------------------------- */
/* The keys themselves.                                                        */
/* -------------------------------------------------------------------------- */

describe("the Phase 4 key hierarchy", () => {
  /**
   * ⚠️ REQUESTS AND APPROVALS KEEP SEPARATE PREFIXES. They look mergeable — both
   * are "a form that gets approved" — and they are not: different tables,
   * different auth models, different lifecycles (CLAUDE.md). A shared prefix
   * would make a Gate 1 decision refetch somebody's leave queue, and would be
   * the first step towards unifying them behind a flag.
   */
  it("keeps client requests and internal approvals apart", () => {
    expect(qk.requests({})[0]).toBe("requests");
    expect(qk.approvals({})[0]).toBe("approvals");
    expect(qk.request(REQUEST)[0]).toBe("request");
    expect(qk.approval(REQUEST)[0]).toBe("approval");
  });

  /**
   * The three `["lists"]` entries are DIFFERENT ROW SETS under ONE prefix, which
   * is what lets a rename sweep them together while none of them can overwrite
   * another. `keys.ts` argues each at length.
   */
  it("gives the three list row sets their own entries under one prefix", () => {
    const managed = qk.listsManaged();
    const visible = qk.listsVisible();
    const byDept = qk.lists(DEPT);

    expect(managed[0]).toBe("lists");
    expect(visible[0]).toBe("lists");
    expect(byDept[0]).toBe("lists");
    expect(new Set([managed[1], visible[1], byDept[1]]).size).toBe(3);
  });

  /** A part is invalidated by its parent and not by the plural sweep. */
  it("nests the request and approval parts under their own row", () => {
    expect(qk.requestPart(REQUEST, "review").slice(0, 2)).toEqual(qk.request(REQUEST));
    expect(qk.approvalPart(REQUEST, "chain").slice(0, 2)).toEqual(qk.approval(REQUEST));
    expect(qk.requestPart(REQUEST, "review")[0]).not.toBe(qk.requests({})[0]);
  });
});
