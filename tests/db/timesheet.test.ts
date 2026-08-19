import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, todayInAppZone } from "@/lib/dates";

import {
  DEPARTMENTS,
  adminClient,
  dbTestsEnabled,
  isPermissionDenied,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P6-01 — the timesheet's database rules.
 *
 * The unit suite covers the schema and the week maths. Everything here needs a
 * real database and a real session, because every assertion is about something
 * a CLIENT must not be able to do: log against somebody else's task, log to
 * tomorrow, write a row under another person's name, or put 30 hours in a day.
 *
 * Run through the publishable key with a signed-in user, never the service key.
 * The service role bypasses policies, so a suite that used it would pass while
 * proving nothing — which is the specific way a security suite rots.
 */

/**
 * `process.stderr.write`, NOT `console.warn` — vitest 4 swallows module-level
 * console output, so the older suites have been skipping silently. Documented
 * in tests/db/phase5.test.ts and repeated here rather than inherited, since a
 * skip nobody sees reports green while proving nothing.
 */
function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`timesheet.test.ts — ${skipReason}`);

/**
 * Detected at MODULE LOAD. `it.skipIf(...)` is evaluated during collection,
 * before any hook runs, so a flag set in `beforeAll` is still false at every
 * skip decision — that has gone wrong in this repo once already (docs/13).
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_timesheet_entries").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "timesheet.test.ts — SKIPPED. 20260817090000_p6_01_timesheet.sql has not been applied" +
      " to this project. Run `npm run db:push`, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const today = todayInAppZone();
const tomorrow = addDays(today, 1)!;

const createdTasks: string[] = [];
const touchedUsers = new Set<string>();

let picId = "";
let outsiderId = "";
/** A task where member1 is PIC and member2 is QA. */
let ownTaskId = "";
/** A task neither of them is on — the one member1 must not be able to log to. */
let foreignTaskId = "";

async function makeTask(assignee: string, qa: string | null): Promise<string> {
  const { client } = await signIn("tlVizBytes");

  const { data, error } = await client.rpc("vizserve_pms_create_task", {
    p_department_id: DEPARTMENTS.VizBytes,
    p_title: `P6 fixture ${Math.random().toString(36).slice(2, 8)}`,
    p_description: "Created by the P6 timesheet suite.",
    p_assignee_id: assignee,
    p_qa_assignee_id: qa,
    p_due_date: "2026-12-01",
    p_list_id: null,
  });

  if (error) throw new Error(`fixture task: ${error.message}`);

  const id = (data as { task_id: string }).task_id;
  createdTasks.push(id);
  return id;
}

async function clearEntries(userId: string) {
  touchedUsers.add(userId);
  await adminClient().from("vizserve_pms_timesheet_entries").delete().eq("user_id", userId);
}

beforeAll(async () => {
  if (!run) return;

  const pic = await signIn("member1VizBytes");
  const qa = await signIn("member2VizBytes");
  const outsider = await signIn("member1VizAssists");

  picId = pic.userId;
  outsiderId = outsider.userId;

  ownTaskId = await makeTask(picId, qa.userId);
  // Assigned to the QA reviewer alone, so member1 is neither PIC nor QA on it.
  foreignTaskId = await makeTask(qa.userId, null);

  await clearEntries(picId);
  await clearEntries(outsiderId);
});

afterAll(async () => {
  if (!run) return;
  const admin = adminClient();

  for (const userId of touchedUsers) {
    await admin.from("vizserve_pms_timesheet_entries").delete().eq("user_id", userId);
  }
  // Entries cascade from the task, but the tasks themselves have to go too.
  if (createdTasks.length > 0) {
    await admin.from("vizserve_pms_timesheet_entries").delete().in("task_id", createdTasks);
    await admin.from("vizserve_pms_tasks").delete().in("id", createdTasks);
  }
});

// ---------------------------------------------------------------------------
// Exit criterion: "Time cannot be logged without a task." (docs/09)
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P6-01 — time cannot be logged without a task", () => {
  it("refuses a null task_id at the column", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      // The whole feature, tested at the only layer that cannot be skipped.
      task_id: null as unknown as string,
      work_date: today,
      minutes: 60,
    });

    expect(error).not.toBeNull();
    // A NOT NULL violation, not a policy refusal — those are different fixes.
    expect(isPermissionDenied(error)).toBe(false);
  });

  it("refuses a task the person is neither PIC nor QA on", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: foreignTaskId,
      work_date: today,
      minutes: 60,
    });

    // This one IS the policy: vizserve_pms_may_log_time inside the WITH CHECK.
    expect(error).not.toBeNull();
  });

  it("accepts a task the person is the PIC on", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 90,
      note: "first pass",
    });

    expect(error).toBeNull();
  });

  it("accepts a task the person is the QA reviewer on", async () => {
    const qa = await signIn("member2VizBytes");
    await clearEntries(qa.userId);

    const { error } = await qa.client.from("vizserve_pms_timesheet_entries").insert({
      user_id: qa.userId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 30,
      note: "review",
    });

    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Writes are first person. A lead reads a team's hours and cannot write them.
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P6-01 — writes are first person only", () => {
  it("refuses a row written under somebody else's user_id", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
      // The task is member1's, but the row claims to be the outsider's. The
      // policy tests user_id = auth.uid(), so this is refused even though the
      // task check would pass for the caller.
      user_id: outsiderId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 60,
    });

    expect(error).not.toBeNull();
  });

  it("lets a department lead READ a member's entries", async () => {
    const lead = await signIn("tlVizBytes");

    const { data, error } = await lead.client
      .from("vizserve_pms_timesheet_entries")
      .select("id, minutes")
      .eq("user_id", picId);

    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("does NOT let a department lead write one", async () => {
    const lead = await signIn("tlVizBytes");

    const { error } = await lead.client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 60,
    });

    expect(error).not.toBeNull();
  });

  it("does NOT let a department lead edit one — zero rows, not an error", async () => {
    // Different shape of refusal from the insert above, and the one the lead's
    // team view (P6-05) depends on: an UPDATE refused by a policy is reported
    // as SUCCESS with zero rows affected. A screen that trusted `error` here
    // would tell a lead they had corrected somebody's hours when they had not.
    const lead = await signIn("tlVizBytes");

    const { data: mine } = await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .select("id, minutes")
      .eq("user_id", picId)
      .limit(1)
      .maybeSingle();

    if (!mine) return;

    const { data, error } = await lead.client
      .from("vizserve_pms_timesheet_entries")
      .update({ minutes: 1 })
      .eq("id", mine.id)
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: after } = await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .select("minutes")
      .eq("id", mine.id)
      .single();

    expect(after!.minutes).toBe(mine.minutes);
  });

  it("does not leak a member's entries to another department's member", async () => {
    const outsider = await signIn("member1VizAssists");

    const { data, error } = await outsider.client
      .from("vizserve_pms_timesheet_entries")
      .select("id")
      .eq("user_id", picId);

    // A working policy returns ZERO ROWS. `permission denied` would be a
    // missing GRANT and a different bug entirely (docs/13).
    expect(isPermissionDenied(error)).toBe(false);
    expect(data ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dates and totals
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P6-01 — dates and daily totals", () => {
  it("refuses a future work_date", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: ownTaskId,
      work_date: tomorrow,
      minutes: 60,
    });

    expect(error).not.toBeNull();
  });

  it("allows several entries against the same task on the same day", async () => {
    const { client } = await signIn("member1VizBytes");
    await clearEntries(picId);

    for (const minutes of [60, 30, 45]) {
      const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
        user_id: picId,
        task_id: ownTaskId,
        work_date: today,
        minutes,
      });
      expect(error).toBeNull();
    }

    const { data } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("minutes")
      .eq("user_id", picId)
      .eq("work_date", today);

    expect((data ?? []).reduce((sum, row) => sum + row.minutes, 0)).toBe(135);
  });

  it("refuses to let a day exceed 24 hours across several entries", async () => {
    const { client } = await signIn("member1VizBytes");
    await clearEntries(picId);

    // 23 hours in, legitimately.
    const { error: first } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 1380,
    });
    expect(first).toBeNull();

    // The 25th hour. Each row passes the per-row CHECK on its own — this is the
    // trigger, which is the only layer that can see the pair.
    const { error: second } = await client.from("vizserve_pms_timesheet_entries").insert({
      user_id: picId,
      task_id: ownTaskId,
      work_date: today,
      minutes: 120,
    });
    expect(second).not.toBeNull();
    expect(second?.message ?? "").toContain("24 hours");
  });

  it("refuses zero and negative durations", async () => {
    const { client } = await signIn("member1VizBytes");
    await clearEntries(picId);

    for (const minutes of [0, -30]) {
      const { error } = await client.from("vizserve_pms_timesheet_entries").insert({
        user_id: picId,
        task_id: ownTaskId,
        work_date: today,
        minutes,
      });
      expect(error).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// anon holds no privileges on this table, like every other table (docs/13).
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P6-01 — anon is locked out", () => {
  it("cannot read the timesheet at all", async () => {
    const { anonClient } = await import("./helpers");

    const { data, error } = await anonClient()
      .from("vizserve_pms_timesheet_entries")
      .select("id")
      .limit(1);

    // `permission denied` is the RIGHT answer here — anon holds no table
    // privileges, which is a GRANT fact, not a policy one.
    expect(isPermissionDenied(error) || (data ?? []).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Your hours are yours, whatever happens to the task afterwards.
//
// The entries policy returns a row on `user_id = auth.uid()` and says nothing
// about the task. The TASKS policy is narrower — PIC, QA, or department lead —
// so the two diverge the moment a task is reassigned away from somebody who
// already logged time against it.
//
// That divergence is invisible until a query joins the two. `!inner` turns "I
// cannot see that task" into "that row does not exist", and the hours disappear
// from the person's own timesheet, from their day and week totals, and from any
// figure derived from them.
// ---------------------------------------------------------------------------
describe.skipIf(!run)("entries survive losing sight of their task", () => {
  /** Put back whatever the transfer below moved, whether or not it asserted. */
  let transferred: { id: string; department: string } | null = null;

  afterAll(async () => {
    if (!run || !transferred) return;
    await adminClient()
      .from("vizserve_pms_users")
      .update({ primary_department_id: transferred.department })
      .eq("id", transferred.id);
  });

  it("keeps returning the entry after the owner leaves the department", async () => {
    /*
     * ⚠️ THIS USED TO REASSIGN THE TASK TO A COLLEAGUE, and P7-17 made that stop
     * putting it out of scope — a member now reads every non-personal task in
     * their own department, so the original PIC could still see it and the case
     * quietly stopped testing anything.
     *
     * Everything simpler was tried and is genuinely unreachable now:
     *
     *   move the task            `department_id` and `is_personal` sit outside
     *                            the column grant, deliberately
     *   borrow somebody          `add_task_assignee` refuses anyone whose
     *                            department is not the task's
     *   log from outside         `may_log_time` IS `is_on_task`
     *
     * Which leaves one route, and it is a real one: somebody leaves the team
     * and their old hours must not vanish from their own timesheet. A VizBooks
     * member is used because this mutates a shared row and no other file signs
     * in as one.
     */
    const worker = await signIn("member2VizBooks");
    const lead = await signIn("tlVizBooks");
    await clearEntries(worker.userId);

    const { data: created, error: madeTask } = await lead.client.rpc("vizserve_pms_create_task", {
      p_department_id: DEPARTMENTS.VizBooks,
      p_title: `P6 transfer fixture ${Math.random().toString(36).slice(2, 8)}`,
      p_description: "Their work, until they moved teams.",
      p_assignee_id: worker.userId,
      p_qa_assignee_id: null,
      p_due_date: "2026-12-01",
      p_list_id: null,
    });
    expect(madeTask).toBeNull();

    const taskId = (created as { task_id: string }).task_id;
    createdTasks.push(taskId);

    const { error: logged } = await worker.client.from("vizserve_pms_timesheet_entries").insert({
      user_id: worker.userId,
      task_id: taskId,
      work_date: today,
      minutes: 120,
    });
    expect(logged).toBeNull();

    /*
     * They leave the department, and the work stays behind with somebody who is
     * still on it. Both halves are needed: the department clause AND
     * `assignee_id` have to stop matching, or the task is still in sight.
     *
     * ⚠️ MOVED TO NULL, NOT TO ANOTHER DEPARTMENT. Parking them in one for the
     * duration is visible to every other file running in parallel —
     * `approval-engine` and `tasks` both select users by
     * `primary_department_id`, and an extra body in the result is a flake that
     * appears in whichever suite happens to overlap. Null belongs to nobody's
     * query, and "no longer in that department" is the whole of what this case
     * needs to say.
     */
    transferred = { id: worker.userId, department: DEPARTMENTS.VizBooks };

    const { error: moved } = await adminClient()
      .from("vizserve_pms_users")
      .update({ primary_department_id: null })
      .eq("id", worker.userId);
    expect(moved).toBeNull();

    const { error: handedOver } = await adminClient()
      .from("vizserve_pms_tasks")
      .update({ assignee_id: lead.userId })
      .eq("id", taskId);
    expect(handedOver).toBeNull();

    // A fresh session, so the transfer is certainly in play rather than being
    // read through a token minted before it.
    const after = await signIn("member2VizBooks");

    // The task is now out of scope for them: not the assignee, not the
    // reviewer, not on the join table, not in their department. This is the
    // state the rest of the case depends on.
    const { data: taskRows } = await after.client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", taskId);
    expect(taskRows).toHaveLength(0);

    const client = after.client;
    const picId = worker.userId;

    // The ENTRY must still be theirs. This is the policy doing its job.
    const { data: plain } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("id, minutes")
      .eq("user_id", picId)
      .eq("work_date", today);

    expect(plain).toHaveLength(1);
    expect(plain![0]!.minutes).toBe(120);

    // THIS IS THE BUG, pinned so nobody reintroduces it. An inner join to a
    // table with a narrower policy does not return a row with a null embed —
    // it drops the row entirely. Two hours of somebody's week, gone from their
    // own screen, with no error anywhere to explain it.
    const { data: innerJoined } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("id, minutes, vizserve_pms_tasks!inner(title, status)")
      .eq("user_id", picId)
      .eq("work_date", today);

    expect(innerJoined).toHaveLength(0);

    // The shape the page must use instead. A left embed keeps the row and
    // returns null for the task, which the screen already renders as a
    // placeholder title — the hours are the part that must not vanish.
    const { data: joined } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("id, minutes, vizserve_pms_tasks(title, status)")
      .eq("user_id", picId)
      .eq("work_date", today);

    expect(joined).toHaveLength(1);
    expect(joined![0]!.minutes).toBe(120);
    expect(joined![0]!.vizserve_pms_tasks).toBeNull();
  });
});
