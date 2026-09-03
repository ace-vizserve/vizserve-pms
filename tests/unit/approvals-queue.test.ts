import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  countWaitingOnYou,
  listPendingTimesheetWeeks,
  listWaitingOnYou,
  timesheetWeekHref,
} from "@/lib/approvals-queue-server";
import type { Database } from "@/lib/database.types";

/**
 * "Waiting on you", pinned against the divergence that produced it.
 *
 * ⚠️ THE BUG THIS FILE IS ABOUT IS A WRONG ZERO. `/dashboard` counted one of the
 * three queues and told a lead with a full inbox they had nothing to do — twice,
 * per the header of `lib/approvals-queue-server.ts`. `/approvals` then listed a
 * different subset again. There is no database here to prove the queries are
 * right, so what is checked is the part that DRIFTS: which filters each read
 * applies, and that the count and the list apply the same ones.
 *
 * The client is a fake recorder, not a mock of PostgREST. It cares only that
 * `.eq("status", "SUBMITTED")` and `.neq("user_id", me)` are both on the wire —
 * the second is self-approval, which `vizserve_pms_decide_timesheet_week`
 * refuses, so a week of your own in your own queue is work that cannot be worked
 * off.
 */

type Filter = [method: string, column: string, value: unknown];

type Recorded = {
  table: string;
  select: string;
  head: boolean;
  filters: Filter[];
  order?: { column: string; ascending?: boolean };
  limit?: number;
};

type Response = { data?: unknown; error?: { message: string } | null; count?: number };

function fakeSupabase(responses: Record<string, Response>) {
  const calls: Recorded[] = [];

  const client = {
    from(table: string) {
      const call: Recorded = { table, select: "", head: false, filters: [] };
      calls.push(call);

      // Every method returns the builder, and the builder is a thenable — which
      // is all `await` and `Promise.all` need from it.
      const builder = {
        select(columns: string, options?: { count?: string; head?: boolean }) {
          call.select = columns;
          call.head = Boolean(options?.head);
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value]);
          return builder;
        },
        neq(column: string, value: unknown) {
          call.filters.push(["neq", column, value]);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          call.order = { column, ...options };
          return builder;
        },
        limit(count: number) {
          call.limit = count;
          return builder;
        },
        then(resolve: (value: Response) => unknown) {
          const response = responses[table] ?? { data: [], error: null, count: 0 };
          return Promise.resolve({ error: null, ...response }).then(resolve);
        },
      };

      return builder;
    },
    rpc() {
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { supabase: client as unknown as SupabaseClient<Database>, calls };
}

const WEEKS = "vizserve_pms_timesheet_weeks";

const weekRow = {
  id: "week-1",
  user_id: "someone-else",
  week_start: "2026-08-17",
  submitted_minutes: 2400,
  submitted_at: "2026-08-24T01:02:03.000Z",
  status: "SUBMITTED",
  vizserve_pms_users: { full_name: "Kurt" },
};

describe("listPendingTimesheetWeeks", () => {
  it("asks for submitted weeks that are not the caller's own", () => {
    const { supabase, calls } = fakeSupabase({ [WEEKS]: { data: [weekRow] } });

    return listPendingTimesheetWeeks(supabase, "me", true, 7).then(() => {
      const call = calls.find((entry) => entry.table === WEEKS)!;
      expect(call.filters).toContainEqual(["eq", "status", "SUBMITTED"]);
      // Self-approval. The decide function refuses it; listing it would put a
      // number in a queue nobody can clear.
      expect(call.filters).toContainEqual(["neq", "user_id", "me"]);
      // No department filter of any kind — RLS scopes the table by the
      // department snapshotted at submission (CLAUDE.md).
      expect(call.filters).toHaveLength(2);
      // Oldest first: the bottom of a newest-first queue is the part that has
      // been waiting longest, and nobody reaches it.
      expect(call.order).toEqual({ column: "week_start", ascending: true });
      expect(call.limit).toBe(7);
    });
  });

  it("never queries at all for somebody who approves nothing", async () => {
    const { supabase, calls } = fakeSupabase({});
    await expect(listPendingTimesheetWeeks(supabase, "me", false)).resolves.toEqual({
      rows: [],
      error: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("carries the submitted total, the name and the destination", async () => {
    const { supabase } = fakeSupabase({ [WEEKS]: { data: [weekRow] } });
    const { rows } = await listPendingTimesheetWeeks(supabase, "me", true);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Kurt",
      weekStart: "2026-08-17",
      // What the person ATTESTED TO, not a live recount.
      submittedMinutes: 2400,
      status: "SUBMITTED",
      href: "/timesheet/team?week=2026-08-17",
    });
  });

  it("survives an embed that came back empty", async () => {
    const { supabase } = fakeSupabase({
      [WEEKS]: { data: [{ ...weekRow, vizserve_pms_users: null }] },
    });
    const { rows } = await listPendingTimesheetWeeks(supabase, "me", true);
    // Null, not "A colleague": the fallback wording belongs to whichever screen
    // renders it, and /approvals shows it in a "From" column of its own.
    expect(rows[0]!.name).toBeNull();
  });

  it("RETURNS THE ERROR rather than an empty queue", async () => {
    const { supabase } = fakeSupabase({
      [WEEKS]: { data: null, error: { message: "permission denied for table" } },
    });
    const { rows, error } = await listPendingTimesheetWeeks(supabase, "me", true);

    // The whole point. `data ?? []` here renders a broken read as "nothing is
    // waiting on you", and an empty approvals queue is the one people believe.
    expect(rows).toEqual([]);
    expect(error?.message).toBe("permission denied for table");
  });
});

describe("the count and the list agree about what is waiting", () => {
  it("applies the same two filters to weeks on both paths", async () => {
    const counted = fakeSupabase({
      vizserve_pms_requests: { count: 1 },
      vizserve_pms_internal_requests: { count: 2 },
      [WEEKS]: { count: 3 },
    });
    await countWaitingOnYou(counted.supabase, "me", true);

    const listed = fakeSupabase({ [WEEKS]: { data: [] } });
    await listPendingTimesheetWeeks(listed.supabase, "me", true);

    const filtersOn = (calls: Recorded[]) => calls.find((entry) => entry.table === WEEKS)!.filters;

    // Written out twice in the module — one read wants a head count and the
    // other an embed — so this is the thing standing between them and drift.
    expect(filtersOn(counted.calls)).toEqual(filtersOn(listed.calls));
  });

  it("counts a member's queues as zero without asking the database", async () => {
    const { supabase, calls } = fakeSupabase({});
    const waiting = await countWaitingOnYou(supabase, "me", false);
    expect(waiting.total).toBe(0);
    expect(waiting.breakdown).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("names only the queues that have something in them", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { count: 0 },
      vizserve_pms_internal_requests: { count: 4 },
      [WEEKS]: { count: 3 },
    });
    const waiting = await countWaitingOnYou(supabase, "me", true);

    expect(waiting.total).toBe(7);
    expect(waiting.breakdown).toBe("4 internal · 3 weeks");
  });
});

describe("listWaitingOnYou — the rows behind the count", () => {
  it("sends a week row to the grid that decides it, not to /approvals/<id>", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { data: [] },
      vizserve_pms_internal_requests: { data: [] },
      [WEEKS]: { data: [weekRow] },
      vizserve_pms_users: { data: [] },
    });

    const rows = await listWaitingOnYou(supabase, "me", true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "wk-week-1",
      kind: "Timesheet",
      who: "Kurt",
      // A date string, not prose — the caller decides the tense.
      since: "2026-08-24",
      href: timesheetWeekHref("2026-08-17"),
    });
  });
});
