import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { fetchForms } from "@/lib/query/fetchers/forms";
import { fetchDepartments, fetchLeaveTypes } from "@/lib/query/fetchers/ref";
import { fetchDepartmentReport } from "@/lib/query/fetchers/reports";
import type { TaskReadClient } from "@/lib/query/fetchers/task";
import { ReadError } from "@/lib/query/read";

/**
 * P12-20 … P12-22 — the reads behind reference data, `/forms` and `/reports`.
 *
 * ⚠️ ONE HAPPY CASE PER FETCHER, AND NOTHING ELSE THAT IS GENERIC. The four
 * failure paths — happy, sad, EMPTY, permission — are properties of `read()`
 * and are asserted once in `tests/unit/query-layer.test.ts`. Re-asserting them
 * per domain would be a dozen copies of the same three lines;
 * `phase4-fetchers.test.ts` takes the same position and says so at greater
 * length.
 *
 * WHAT IS PHASE-6-SPECIFIC, and therefore what is actually worth a test:
 *
 *   1. THE REFERENCE FETCHERS DO NOT FILTER `is_active`. This is the whole of
 *      P12-20 and it is a WIDENING that four screens now depend on — a retired
 *      department must still be nameable on `/reports`, a retired leave type
 *      must still be selectable as an audit filter. A `.eq("is_active", true)`
 *      creeping back in is the regression, and it would show up as figures
 *      labelled "Another department" rather than as a failure.
 *   2. `/forms` TALLIES ITS SUBMISSIONS IN THE BROWSER and keeps the NEWEST
 *      timestamp per form. The query has no order, so "newest wins" has to be a
 *      comparison and not an assumption.
 *   3. `/reports` DERIVES ITS THREE BANDS rather than listing them, tallies
 *      hours through an `!inner` embed, and counts an unanswered Gate 3 into the
 *      DENOMINATOR. Those are the three derivations somebody could get wrong
 *      without any test noticing.
 *   4. `/reports` THROWS ON A FAILED READ. This is the P12-01 half of the phase:
 *      the four loaders in `lib/reports-server.ts` destructured `{ data }` and
 *      discarded the error, so a dead socket rendered as "no client has given
 *      feedback in this period". One assertion is enough to stop it coming back.
 *   5. NOTHING VARIABLE-LENGTH GOES IN A FILTER. Every metric is one query with
 *      an `!inner` embed rather than "fetch ids, then fetch by ids" — the whole
 *      of the 16,542-character URL bug.
 *
 * No mocking framework, and there must not be one: every fetcher takes its
 * client as an argument, so the object literal below is a complete double.
 */

const DEPT_A = "cccccccc-0000-4000-8000-000000000001";
const DEPT_B = "cccccccc-0000-4000-8000-000000000002";
const FORM_A = "ffffffff-0000-4000-8000-000000000001";
const FORM_B = "ffffffff-0000-4000-8000-000000000002";
const USER = "dddddddd-0000-4000-8000-000000000004";
const TYPE_A = "22222222-0000-4000-8000-000000000001";
const TYPE_B = "22222222-0000-4000-8000-000000000002";
const TASK = "aaaaaaaa-0000-4000-8000-000000000001";
const TASK_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const TASK_3 = "aaaaaaaa-0000-4000-8000-000000000003";
const TASK_4 = "aaaaaaaa-0000-4000-8000-000000000004";
const REQUEST = "bbbbbbbb-0000-4000-8000-000000000001";

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

type Recorded = {
  table: string;
  select?: string;
  filters: [string, string, unknown][];
  order: string[];
};

/**
 * A PostgREST-shaped stub.
 *
 * ⚠️ ANSWERS ARE A QUEUE PER TABLE, WHERE `phase4-fetchers.test.ts` USES ONE
 * ANSWER PER TABLE. `/reports` reads `vizserve_pms_requests` TWICE in one wave —
 * once for the status tally over `created_at`, once for the negotiation split
 * over `reviewed_at` — and they are genuinely different row sets. A single
 * answer per table would have made the two indistinguishable and would have
 * quietly passed a fetcher that read the wrong one twice.
 *
 * ⚠️ THE BUILDER IS A THENABLE, NOT A PROMISE, because that is what the real one
 * is — `.then()` is what fires the request, which is why `read()` accepts a
 * `PromiseLike`. A stub returning a plain promise from `.select()` would pass
 * these tests and fail against the library.
 */
function stubClient(tables: Record<string, Answer[]>): {
  client: TaskReadClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const queues: Record<string, Answer[]> = Object.fromEntries(
    Object.entries(tables).map(([table, answers]) => [table, [...answers]]),
  );

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
      is: filter("is"),
      not: filter("not"),
      in: filter("in"),
      gte: filter("gte"),
      lt: filter("lt"),
      lte: filter("lte"),
      order(column: string) {
        call.order.push(column);
        return builder;
      },
      then(onfulfilled: unknown, onrejected: unknown) {
        return settled.then(onfulfilled as never, onrejected as never);
      },
    };
    return builder;
  };

  const client = {
    from(table: string) {
      const call: Recorded = { table, filters: [], order: [] };
      calls.push(call);
      const answer = queues[table]?.shift() ?? { data: [], error: null };
      return build(call, answer);
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };

  /* ⚠️ CAST ONCE, AT THE BOUNDARY, AND ONLY IN THE TEST. The fetchers keep the
     generated column types in production; describing a builder chain
     structurally would mean hand-copying `PostgrestFilterBuilder`, which would
     drift from the library on its next minor. */
  return { client: client as unknown as TaskReadClient, calls };
}

const hasFilter = (call: Recorded | undefined, op: string, column: string) =>
  Boolean(call?.filters.some(([o, c]) => o === op && c === column));

/* -------------------------------------------------------------------------- */
/* P12-20 — reference data                                                     */
/* -------------------------------------------------------------------------- */

describe("qk.ref fetchers", () => {
  it("fetchDepartments KEEPS the retired departments, with the flag to tell them apart", async () => {
    const { client, calls } = stubClient({
      vizserve_pms_departments: [
        {
          data: [
            { id: DEPT_A, name: "VizMedia", is_active: true },
            { id: DEPT_B, name: "Folded in June", is_active: false },
          ],
          error: null,
        },
      ],
    });

    await expect(fetchDepartments(client)).resolves.toEqual([
      { id: DEPT_A, name: "VizMedia", is_active: true },
      { id: DEPT_B, name: "Folded in June", is_active: false },
    ]);

    /*
     * ⚠️ THE ASSERTION THAT MATTERS IS THE ABSENCE OF A FILTER. This read had
     * `.eq("is_active", true)` while the create-task picker was its only
     * consumer. `/reports` labels every figure from this entry, and a retired
     * department dropped here prints as "Another department" — a sentence about
     * permissions standing over a number whose real problem was a checkbox.
     * The picker filters the column itself; see `new-task-button.tsx`.
     */
    expect(hasFilter(calls[0], "eq", "is_active")).toBe(false);
    expect(calls[0]?.select).toContain("is_active");
  });

  it("fetchLeaveTypes KEEPS the retired types, in HR's own order", async () => {
    const { client, calls } = stubClient({
      vizserve_pms_leave_types: [
        {
          data: [
            { id: TYPE_A, label: "Vacation", sort_order: 0, is_active: true },
            { id: TYPE_B, label: "Withdrawn in March", sort_order: 9, is_active: false },
          ],
          error: null,
        },
      ],
    });

    const types = await fetchLeaveTypes(client);
    expect(types.map((type) => type.label)).toEqual(["Vacation", "Withdrawn in March"]);

    /*
     * Filtering an audit TO a withdrawn type is the question `/hr/reports`
     * exists to answer, so this entry must hold them. The FILING picker is a
     * different row set under a different key and does filter — see
     * `fetchFilingOptions` in `fetchers/approvals.ts`.
     */
    expect(hasFilter(calls[0], "eq", "is_active")).toBe(false);
    expect(calls[0]?.order).toEqual(["sort_order", "label"]);
  });
});

/* -------------------------------------------------------------------------- */
/* P12-22 — /forms                                                             */
/* -------------------------------------------------------------------------- */

describe("fetchForms", () => {
  const FORM_ROW = {
    id: FORM_A,
    name: "Video request",
    slug: "video-request",
    purpose: "CLIENT_REQUEST",
    is_public: true,
    is_active: true,
    reference_prefix: "VID",
    department_id: DEPT_A,
    created_by: USER,
    created_at: "2026-08-01T00:00:00Z",
    sla_minutes: 2880,
    requires_attachment: false,
  };

  it("tallies submissions per form and keeps the NEWEST timestamp", async () => {
    const { client } = stubClient({
      vizserve_pms_forms: [
        { data: [FORM_ROW, { ...FORM_ROW, id: FORM_B, slug: "b", name: "Unused" }], error: null },
      ],
      vizserve_pms_requests: [
        {
          data: [
            /* Deliberately NOT in date order: the query has none, so "newest
               wins" has to be a comparison rather than a last-row-wins. */
            { form_id: FORM_A, submitted_at: "2026-09-01T09:00:00Z" },
            { form_id: FORM_A, submitted_at: "2026-09-03T09:00:00Z" },
            { form_id: FORM_A, submitted_at: "2026-09-02T09:00:00Z" },
          ],
          error: null,
        },
      ],
    });

    const result = await fetchForms(client);

    expect(result.forms).toHaveLength(2);
    expect(result.submissionCounts[FORM_A]).toBe(3);
    expect(result.lastSubmission[FORM_A]).toBe("2026-09-03T09:00:00Z");

    /*
     * ⚠️ A FORM WITH NO SUBMISSIONS HAS NO ENTRY AT ALL, rather than a zero.
     * `forms-table.tsx` prints "None" for a missing count and "Not shown" where
     * `submissionsReadable` is false — the two are different sentences and the
     * fetcher must not collapse them by inventing a zero.
     */
    expect(result.submissionCounts[FORM_B]).toBeUndefined();
  });

  it("carries `created_by`, which nothing draws and `administersForm` needs", async () => {
    const { client, calls } = stubClient({
      vizserve_pms_forms: [{ data: [FORM_ROW], error: null }],
    });

    const result = await fetchForms(client);

    /*
     * The author carve-out — "an unrouted draft belongs to its author until a
     * department is chosen" — is the one clause of `administersForm` that reads
     * a column nothing on screen prints. A projection that loses it makes a team
     * leader's own new form vanish from their list.
     */
    expect(calls[0]?.select).toContain("created_by");
    expect(result.forms[0]?.created_by).toBe(USER);
  });
});

/* -------------------------------------------------------------------------- */
/* P12-21 — /reports                                                           */
/* -------------------------------------------------------------------------- */

describe("fetchDepartmentReport", () => {
  const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

  function reportAnswers(overrides: Record<string, Answer[]> = {}) {
    return {
      vizserve_pms_tasks: [
        {
          data: [
            { id: TASK, status: "OPEN", department_id: DEPT_A, due_date: null },
            { id: TASK_2, status: "ONGOING", department_id: DEPT_A, due_date: null },
            { id: TASK_3, status: "COMPLETED", department_id: DEPT_A, due_date: null },
            { id: TASK_4, status: "OPEN", department_id: DEPT_B, due_date: null },
          ],
          error: null,
        },
      ],
      vizserve_pms_requests: [
        { data: [{ id: REQUEST, status: "PENDING_REVIEW" }], error: null },
        { data: [], error: null },
      ],
      vizserve_pms_timesheet_entries: [
        {
          data: [
            { minutes: 90, vizserve_pms_tasks: { department_id: DEPT_A } },
            /* The `!inner` embed guarantees the join, but neither the generated
               type nor the schema knows it. A null is skipped, not fatal. */
            { minutes: 30, vizserve_pms_tasks: null },
          ],
          error: null,
        },
      ],
      vizserve_pms_task_status_history: [{ data: [], error: null }],
      vizserve_pms_client_decisions: [
        {
          data: [
            { decision: "APPROVED" },
            { decision: "AUTO_COMPLETED" },
            { decision: "AUTO_COMPLETED" },
            { decision: "REVISION_REQUESTED" },
          ],
          error: null,
        },
      ],
      vizserve_pms_feedback: [{ data: [], error: null }],
      ...overrides,
    };
  }

  it("derives the three bands and tallies hours through the embed", async () => {
    const { client } = stubClient(reportAnswers());
    const report = await fetchDepartmentReport(client, PERIOD);

    const a = report.departments.find((row) => row.id === DEPT_A);

    /*
     * ⚠️ THE BANDS ARE DERIVED, NOT LISTED. `INITIAL_TASK_STATUS` and
     * `isTerminal` are the same two facts the status dropdown groups by, so a
     * status added to the enum lands in the right band without anybody
     * remembering to come back. A hand-written "active statuses" list is the
     * copy that goes stale.
     */
    expect(a).toMatchObject({ notStarted: 1, active: 1, done: 1, total: 3 });
    expect(a?.byStatus.ONGOING).toBe(1);

    /* Only the entry whose embed resolved. 30 minutes with no task is dropped. */
    expect(a?.minutes).toBe(90);

    expect(report.totals).toMatchObject({ total: 4, notStarted: 2, active: 1, done: 1 });

    /*
     * ⚠️ THE NAME IS NOT RESOLVED HERE. The row carries its department's id and
     * an empty name; `reports-view.tsx` labels it from `qk.ref("departments")`.
     * Reading a name off this payload would mean the eighth query came back.
     */
    expect(a?.name).toBe("");
  });

  it("counts an unanswered Gate 3 into the DENOMINATOR", async () => {
    const { client } = stubClient(reportAnswers());
    const report = await fetchDepartmentReport(client, PERIOD);

    /*
     * `APPROVED` and `REVISION_REQUESTED` are both a client ENGAGING — one of
     * them is a client reading the work and asking for changes, which is the
     * gate doing precisely its job. `AUTO_COMPLETED` is the cron closing
     * something nobody looked at, and a percentage taken over answered decisions
     * only would always read 100% and would say nothing at all.
     */
    expect(report.engagement).toMatchObject({
      decisions: 4,
      approved: 1,
      revisionRequested: 1,
      autoCompleted: 2,
      engagementPercent: 50,
    });
  });

  it("reads the two requests queries as DIFFERENT row sets", async () => {
    const { client, calls } = stubClient(reportAnswers());
    await fetchDepartmentReport(client, PERIOD);

    const requestCalls = calls.filter((call) => call.table === "vizserve_pms_requests");
    expect(requestCalls).toHaveLength(2);

    /* The status tally is over `created_at`; the negotiation split is over
       `reviewed_at`, because the negotiation happens AT REVIEW — a request filed
       in March and approved in April is April's evidence. */
    expect(hasFilter(requestCalls[0], "gte", "created_at")).toBe(true);
    expect(hasFilter(requestCalls[1], "gte", "reviewed_at")).toBe(true);
  });

  it("puts nothing variable-length in a filter", async () => {
    const { client, calls } = stubClient(reportAnswers());
    await fetchDepartmentReport(client, PERIOD);

    /*
     * P9-01's 16,542-character URL: a 444-entry `in.(…)` that `fetch` refused
     * with no status code at all. Every metric here is ONE query with an
     * `!inner` embed instead of "fetch ids, then fetch by ids", so the URL is a
     * fixed length whatever the period holds. The only `.in()` in the file is
     * the two-value status list on the turnaround read.
     */
    for (const call of calls) {
      for (const [op, , value] of call.filters) {
        if (op !== "in") continue;
        expect(Array.isArray(value) ? value.length : 2).toBeLessThanOrEqual(2);
      }
    }
  });

  it("THROWS on a failed read rather than reporting an empty period", async () => {
    const { client } = stubClient(
      reportAnswers({
        vizserve_pms_feedback: [
          { data: null, error: pgError("57014", "canceling statement due to statement timeout") },
        ],
      }),
    );

    /*
     * ⚠️ THIS IS THE WHOLE OF P12-01 ON THIS PAGE. `loadFeedback` destructured
     * `{ data }` and threw the error away, so this exact failure rendered as
     * "No client has given feedback in this period" — a sentence somebody
     * repeats in a meeting, on the one screen where people make decisions from
     * numbers.
     */
    await expect(fetchDepartmentReport(client, PERIOD)).rejects.toBeInstanceOf(ReadError);
  });

  it("refuses a row whose shape this build does not recognise", async () => {
    const { client } = stubClient(
      reportAnswers({
        /* `department_id` is NOT NULL on the table. A row without it is a shape
           fault, not a row to skip — the old code cast and would have written a
           band under the key "undefined". */
        vizserve_pms_tasks: [{ data: [{ id: TASK, status: "OPEN", due_date: null }], error: null }],
      }),
    );

    await expect(fetchDepartmentReport(client, PERIOD)).rejects.toBeInstanceOf(ReadError);
  });
});
