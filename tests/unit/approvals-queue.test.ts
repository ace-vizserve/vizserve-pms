import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  countWaitingOnYou,
  listPendingTimesheetWeeks,
  listWaitingOnYou,
  timesheetWeekHref,
  waitingOnMe,
} from "@/lib/approvals-queue-server";
import type { AuthContext } from "@/lib/auth/authorization";
import type { Database } from "@/lib/database.types";

const RELIEVERS = "vizserve_pms_internal_request_relievers";

/**
 * P9-04 — the queue reads take an AuthContext now, not a user id.
 *
 * They have to: "is this waiting on me" turned into a four-way question about
 * the approval stage, and three of the four branches need the caller's role or
 * their managed departments. A bare id could answer none of them.
 */
const leadCtx: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds"> = {
  userId: "me",
  role: "team_leader",
  managedDepartmentIds: ["dept-1"],
};

const memberCtx: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds"> = {
  userId: "me",
  role: "member",
  managedDepartmentIds: [],
};

const managerCtx: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds"> = {
  userId: "me",
  role: "manager",
  managedDepartmentIds: [],
};

/** A pending internal request from somebody else, in a department `leadCtx` leads. */
const pending = (stage: number, id = "req-1") => ({
  id,
  request_type: "LEAVE" as const,
  requester_id: "someone-else",
  department_id: "dept-1",
  approval_stage: stage,
  created_at: "2026-09-01T00:00:00.000Z",
  start_date: "2026-09-10",
  end_date: "2026-09-12",
  work_date: null,
  start_half: "MORNING" as const,
  end_half: "AFTERNOON" as const,
});

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
        // P9-01. `listOwedAsReliever` asks for undecided rows, and a builder
        // that cannot record `.is()` would throw rather than return a queue.
        is(column: string, value: unknown) {
          call.filters.push(["is", column, value]);
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
    await countWaitingOnYou(counted.supabase, leadCtx, true);

    const listed = fakeSupabase({ [WEEKS]: { data: [] } });
    await listPendingTimesheetWeeks(listed.supabase, "me", true);

    const filtersOn = (calls: Recorded[]) => calls.find((entry) => entry.table === WEEKS)!.filters;

    // Written out twice in the module — one read wants a head count and the
    // other an embed — so this is the thing standing between them and drift.
    expect(filtersOn(counted.calls)).toEqual(filtersOn(listed.calls));
  });

  /**
   * ⚠️ P9-01 CHANGED THIS TEST, and the change is the feature.
   *
   * It used to assert that a member's queues cost ZERO queries — "a member
   * approves nothing", so there was nothing to ask. Being named as somebody's
   * reliever is the one thing that puts a decision in front of a person with no
   * role at all, so exactly one read now happens for them. The three approver
   * queues are still skipped.
   */
  it("asks a member only whether they owe somebody cover", async () => {
    const { supabase, calls } = fakeSupabase({ [RELIEVERS]: { data: [] } });
    const waiting = await countWaitingOnYou(supabase, memberCtx, false);
    expect(waiting.total).toBe(0);
    expect(waiting.breakdown).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe(RELIEVERS);
    // Undecided only. A reliever who already accepted is waiting on their
    // colleagues, not on themselves.
    expect(calls[0].filters).toContainEqual(["is", "decision", null]);
  });

  it("gives a member with a hand-over to answer a real number", async () => {
    const { supabase } = fakeSupabase({
      [RELIEVERS]: { data: [{ request_id: "req-1" }, { request_id: "req-2" }] },
    });
    const waiting = await countWaitingOnYou(supabase, memberCtx, false);

    // The wrong zero this whole module exists to prevent, in its newest form.
    expect(waiting.total).toBe(2);
    expect(waiting.breakdown).toBe("2 to cover");
  });

  it("names only the queues that have something in them", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { count: 0 },
      // P9-04. Rows, not a count: the stage rule cannot be a PostgREST filter,
      // so the internal queue is counted in TypeScript.
      vizserve_pms_internal_requests: {
        data: [pending(0, "a"), pending(2, "b"), pending(0, "c"), pending(2, "d")],
      },
      [WEEKS]: { count: 3 },
      [RELIEVERS]: { data: [] },
    });
    const waiting = await countWaitingOnYou(supabase, leadCtx, true);

    expect(waiting.total).toBe(7);
    expect(waiting.breakdown).toBe("4 internal · 3 weeks");
  });

  /**
   * ⚠️ THE WRONG NUMBER P9-04 WOULD OTHERWISE HAVE SHIPPED.
   *
   * A stage-1 request is visible to the department's lead — they lead it — and
   * is not theirs to touch until every reliever has answered. Counted, it sends
   * them to a queue with nothing in it they can do.
   */
  it("does not count a lead's stage-1 requests — the relievers still hold them", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { count: 0 },
      vizserve_pms_internal_requests: { data: [pending(1, "a"), pending(2, "b")] },
      [WEEKS]: { count: 0 },
      [RELIEVERS]: { data: [] },
    });
    const waiting = await countWaitingOnYou(supabase, leadCtx, true);

    expect(waiting.internal).toBe(1);
  });

  it("counts a stage-3 request for a manager who leads no department at all", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { count: 0 },
      vizserve_pms_internal_requests: { data: [pending(3, "a")] },
      [WEEKS]: { count: 0 },
      [RELIEVERS]: { data: [] },
    });
    const waiting = await countWaitingOnYou(supabase, managerCtx, true);

    // The one place in this app where approval authority is company-wide.
    expect(waiting.internal).toBe(1);
  });
});

describe("listWaitingOnYou — the rows behind the count", () => {
  it("sends a week row to the grid that decides it, not to /approvals/<id>", async () => {
    const { supabase } = fakeSupabase({
      vizserve_pms_requests: { data: [] },
      vizserve_pms_internal_requests: { data: [] },
      [WEEKS]: { data: [weekRow] },
      vizserve_pms_users: { data: [] },
      [RELIEVERS]: { data: [] },
    });

    const rows = await listWaitingOnYou(supabase, leadCtx, true);
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

/**
 * P9-04 — the four-way rule on its own.
 *
 * `waitingOnMe` decides which button a person sees, on four screens. It is not
 * the authority — `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are — but a mistake here is the
 * wrong zero this whole module exists to prevent, so each branch is pinned.
 */
describe("waitingOnMe — whose turn is it", () => {
  const none = new Set<string>();

  it("never returns your own request, at any stage", () => {
    for (const stage of [0, 1, 2, 3]) {
      const own = { ...pending(stage), requester_id: "me" };
      expect(waitingOnMe(own, leadCtx, new Set(["req-1"]))).toBe(false);
    }
  });

  it("gives stage 1 to the named reliever and to nobody else", () => {
    expect(waitingOnMe(pending(1), memberCtx, new Set(["req-1"]))).toBe(true);
    // A lead of the department can SEE it. It is not theirs yet.
    expect(waitingOnMe(pending(1), leadCtx, none)).toBe(false);
    expect(waitingOnMe(pending(1), managerCtx, none)).toBe(false);
  });

  it("drops out of a reliever's queue once they have answered", () => {
    // `listOwedAsReliever` filters to undecided rows, so an accepted hand-over
    // simply is not in the set — they are waiting on their colleagues now.
    expect(waitingOnMe(pending(1), memberCtx, none)).toBe(false);
  });

  it("gives stages 0 and 2 to a lead of that department only", () => {
    for (const stage of [0, 2]) {
      expect(waitingOnMe(pending(stage), leadCtx, none)).toBe(true);
      expect(waitingOnMe(pending(stage), memberCtx, none)).toBe(false);
      // A manager who leads no department is not the team leader gate. Stage 3
      // is theirs; stage 2 belongs to whoever actually runs the team.
      expect(waitingOnMe(pending(stage), managerCtx, none)).toBe(false);
      // ...and not a department they do not lead.
      const elsewhere = { ...pending(stage), department_id: "dept-9" };
      expect(waitingOnMe(elsewhere, leadCtx, none)).toBe(false);
    }
  });

  it("gives stage 3 to any manager, in any department", () => {
    const elsewhere = { ...pending(3), department_id: "dept-9" };
    expect(waitingOnMe(elsewhere, managerCtx, none)).toBe(true);
    // The lead who just approved it at stage 2 still sees it and is done with
    // it. The decide function refuses them a second signature outright.
    expect(waitingOnMe(pending(3), leadCtx, none)).toBe(false);
    expect(waitingOnMe(pending(3), memberCtx, none)).toBe(false);
  });

  it("treats a null stage as the unchained path, not as stage zero by accident", () => {
    // Every row written before P9-01 reads 0 from the column default, but a
    // request selected without the column would arrive undefined — and falling
    // through to "nobody" would empty a lead's queue silently.
    const legacy = { ...pending(0), approval_stage: null };
    expect(waitingOnMe(legacy, leadCtx, none)).toBe(true);
  });
});
