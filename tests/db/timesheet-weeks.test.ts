import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";

import {
  DEPARTMENTS,
  adminClient,
  anonClient,
  dbTestsEnabled,
  isPermissionDenied,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P7-05 — submitting a week, deciding on it, and the lock underneath both.
 *
 * THE LOCK IS THE FEATURE. An approval that does not stop the thing being edited
 * afterwards is decoration, so most of this file is about what a submitted week
 * refuses rather than what submission returns.
 *
 * Two of those refusals are easy to get wrong and impossible to see from the
 * client, so they are asserted explicitly:
 *
 *   * a policy-refused UPDATE or DELETE is NOT an error. PostgREST reports
 *     success and affects zero rows, so "did it save?" has to be answered by
 *     counting rows back, not by checking `error`.
 *   * an UPDATE that MOVES a row out of a locked week has to fail too. If the
 *     lock test lives only in WITH CHECK it passes, because WITH CHECK sees the
 *     new row — whose date is not locked. That silently removes hours from an
 *     approved week.
 */

function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`timesheet-weeks.test.ts — ${skipReason}`);

/** Detected at MODULE LOAD — `it.skipIf` is evaluated during collection. */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_timesheet_weeks").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "timesheet-weeks.test.ts — SKIPPED. 20260818110000_p7_05_timesheet_weeks.sql has not been" +
      " applied to this project. Apply it, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const today = todayInAppZone();
const thisMonday = startOfWeek(today)!;
/** A week that is definitely over, so nothing here depends on what day it is. */
const lastMonday = addDays(thisMonday, -7)!;
const priorMonday = addDays(thisMonday, -14)!;

const createdTasks: string[] = [];
const touchedUsers = new Set<string>();

let picId = "";
let taskId = "";

async function makeTask(assignee: string): Promise<string> {
  const { client } = await signIn("tlVizBytes");

  const { data, error } = await client.rpc("vizserve_pms_create_task", {
    p_department_id: DEPARTMENTS.VizBytes,
    p_title: `P7 week fixture ${Math.random().toString(36).slice(2, 8)}`,
    p_description: "Created by the P7 timesheet-week suite.",
    p_assignee_id: assignee,
    p_qa_assignee_id: null,
    p_due_date: "2026-12-01",
    p_list_id: null,
  });

  if (error) throw new Error(`fixture task: ${error.message}`);

  const id = (data as { task_id: string }).task_id;
  createdTasks.push(id);
  return id;
}

/** Wipes both tables for a user, so each test starts from a known week. */
async function reset(userId: string) {
  touchedUsers.add(userId);
  const admin = adminClient();
  await admin.from("vizserve_pms_timesheet_weeks").delete().eq("user_id", userId);
  await admin.from("vizserve_pms_timesheet_entries").delete().eq("user_id", userId);
}

/** One entry, written as the owner so the policies are the thing being tested. */
async function logMinutes(
  client: Awaited<ReturnType<typeof signIn>>["client"],
  userId: string,
  workDate: string,
  minutes: number,
): Promise<string> {
  const { data, error } = await client
    .from("vizserve_pms_timesheet_entries")
    .insert({ user_id: userId, task_id: taskId, work_date: workDate, minutes })
    .select("id")
    .single();

  if (error) throw new Error(`fixture entry: ${error.message}`);
  return data!.id;
}

beforeAll(async () => {
  if (!run) return;

  const pic = await signIn("member1VizBytes");
  picId = pic.userId;
  taskId = await makeTask(picId);

  await reset(picId);
});

afterAll(async () => {
  if (!run) return;
  const admin = adminClient();

  for (const userId of touchedUsers) {
    await admin.from("vizserve_pms_timesheet_weeks").delete().eq("user_id", userId);
    await admin.from("vizserve_pms_timesheet_entries").delete().eq("user_id", userId);
  }

  if (createdTasks.length > 0) {
    await admin.from("vizserve_pms_timesheet_entries").delete().in("task_id", createdTasks);
    await admin.from("vizserve_pms_tasks").delete().in("id", createdTasks);
  }
});

describe.skipIf(!run)("P7-05 — submitting a week", () => {
  it("normalises any day of the week to its Monday", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(picId);
    await logMinutes(client, picId, addDays(lastMonday, 2)!, 120);

    // Submitted with the WEDNESDAY, which is what a hand-edited URL would send.
    const { error } = await client.rpc("vizserve_pms_submit_timesheet_week", {
      p_week_start: addDays(lastMonday, 2)!,
    });

    expect(error).toBeNull();

    const { data: week } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("week_start, status, submitted_minutes, department_id")
      .eq("user_id", picId)
      .single();

    expect(week!.week_start).toBe(lastMonday);
    expect(week!.status).toBe("SUBMITTED");
    expect(week!.submitted_minutes).toBe(120);
    expect(week!.department_id).toBe(DEPARTMENTS.VizBytes);
  });

  it("refuses an empty week", async () => {
    // An approved empty week is a signed statement that somebody did nothing
    // for five days, and is almost always the wrong week.
    const { client } = await signIn("member1VizBytes");
    await reset(picId);

    const { error } = await client.rpc("vizserve_pms_submit_timesheet_week", {
      p_week_start: lastMonday,
    });

    expect(error).not.toBeNull();
  });

  it("refuses a week that has not happened", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(picId);
    await logMinutes(client, picId, today, 60);

    const { error } = await client.rpc("vizserve_pms_submit_timesheet_week", {
      p_week_start: addDays(thisMonday, 7)!,
    });

    expect(error).not.toBeNull();
  });

  it("refuses a second submission of the same week", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(picId);
    await logMinutes(client, picId, lastMonday, 60);

    await client.rpc("vizserve_pms_submit_timesheet_week", { p_week_start: lastMonday });
    const { error } = await client.rpc("vizserve_pms_submit_timesheet_week", {
      p_week_start: lastMonday,
    });

    expect(error).not.toBeNull();
  });
});

describe.skipIf(!run)("P7-05 — a submitted week is read-only", () => {
  let entryId = "";

  beforeAll(async () => {
    if (!run) return;
    const { client } = await signIn("member1VizBytes");
    await reset(picId);

    entryId = await logMinutes(client, picId, lastMonday, 120);
    // A second week, left open, so the lock can be shown to be per-week.
    await logMinutes(client, picId, priorMonday, 60);

    await client.rpc("vizserve_pms_submit_timesheet_week", { p_week_start: lastMonday });
  });

  it("refuses a new entry — INSERT raises, because WITH CHECK does", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: picId, task_id: taskId, work_date: lastMonday, minutes: 30 });

    expect(error).not.toBeNull();
  });

  it("refuses an edit — zero rows, and NOT an error", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .update({ minutes: 999 })
      .eq("id", entryId)
      .select("id");

    // The shape of the refusal is the point. Without `.select`, this reads as
    // a success and the UI says "Updated".
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: row } = await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .select("minutes")
      .eq("id", entryId)
      .single();

    expect(row!.minutes).toBe(120);
  });

  it("refuses an edit that would MOVE the entry out of the locked week", async () => {
    // The USING-clause test. With the lock only in WITH CHECK this succeeds,
    // because WITH CHECK evaluates the new row — whose date is not locked —
    // and an approved week quietly loses hours.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .update({ work_date: priorMonday })
      .eq("id", entryId)
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: row } = await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .select("work_date")
      .eq("id", entryId)
      .single();

    expect(row!.work_date).toBe(lastMonday);
  });

  it("refuses a delete — zero rows, and NOT an error", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .delete()
      .eq("id", entryId)
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("leaves other weeks editable — the lock is per week, not global", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: picId, task_id: taskId, work_date: priorMonday, minutes: 45 })
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("stays readable to its owner", async () => {
    // Readable but unwritable is the entire point of handing a week in.
    const { client } = await signIn("member1VizBytes");

    const { data } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("id")
      .eq("id", entryId);

    expect(data).toHaveLength(1);
  });
});

describe.skipIf(!run)("P7-05 — deciding", () => {
  async function submitFreshWeek(): Promise<string> {
    const { client } = await signIn("member1VizBytes");
    await reset(picId);
    await logMinutes(client, picId, lastMonday, 120);
    await client.rpc("vizserve_pms_submit_timesheet_week", { p_week_start: lastMonday });

    const { data } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("id")
      .eq("user_id", picId)
      .single();

    return data!.id;
  }

  it("approves, and records the decision through the ENGINE", async () => {
    const weekId = await submitFreshWeek();
    const tl = await signIn("tlVizBytes");

    const { error } = await tl.client.rpc("vizserve_pms_decide_timesheet_week", {
      p_id: weekId,
      p_decision: "approved",
      p_reason: null,
    });

    expect(error).toBeNull();

    const { data: week } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("status, reviewed_by")
      .eq("id", weekId)
      .single();

    expect(week!.status).toBe("APPROVED");
    expect(week!.reviewed_by).toBe(tl.userId);

    // The engine was reused, not reimplemented — the same property the
    // rehearsal_widget test proves for the engine itself.
    const { data: approvals } = await adminClient()
      .from("vizserve_pms_approvals")
      .select("entity_type, decision")
      .eq("entity_id", weekId);

    expect(approvals).toHaveLength(1);
    expect(approvals![0]!.entity_type).toBe("timesheet_week");
    expect(approvals![0]!.decision).toBe("approved");
  });

  it("will not send a week back without saying why", async () => {
    // Enforced by the ENGINE's mandatory-reason rule, not by this consumer —
    // which is the point of there being an engine.
    const weekId = await submitFreshWeek();
    const tl = await signIn("tlVizBytes");

    const { error } = await tl.client.rpc("vizserve_pms_decide_timesheet_week", {
      p_id: weekId,
      p_decision: "returned",
      p_reason: "   ",
    });

    expect(error).not.toBeNull();
  });

  it("refuses 'rejected' outright", async () => {
    // Hours that were worked cannot be un-worked. The mirror image of the
    // internal-request consumer, which refuses 'returned'.
    const weekId = await submitFreshWeek();
    const tl = await signIn("tlVizBytes");

    const { error } = await tl.client.rpc("vizserve_pms_decide_timesheet_week", {
      p_id: weekId,
      p_decision: "rejected",
      p_reason: "Not having these hours.",
    });

    expect(error).not.toBeNull();
  });

  it("unlocks the entries when the week is sent back, and lets it be resubmitted", async () => {
    const weekId = await submitFreshWeek();
    const tl = await signIn("tlVizBytes");

    await tl.client.rpc("vizserve_pms_decide_timesheet_week", {
      p_id: weekId,
      p_decision: "returned",
      p_reason: "Tuesday looks like it belongs to the other project.",
    });

    const { client } = await signIn("member1VizBytes");

    const { data: added, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: picId, task_id: taskId, work_date: lastMonday, minutes: 30 })
      .select("id");

    expect(error).toBeNull();
    expect(added).toHaveLength(1);

    // And back it goes, with the previous decision cleared rather than kept —
    // a week showing both "sent back for X" and "submitted" reads as though X
    // is still outstanding.
    const resubmit = await client.rpc("vizserve_pms_submit_timesheet_week", {
      p_week_start: lastMonday,
    });
    expect(resubmit.error).toBeNull();

    const { data: week } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("status, decision_reason, reviewed_by, submitted_minutes")
      .eq("id", weekId)
      .single();

    expect(week!.status).toBe("SUBMITTED");
    expect(week!.decision_reason).toBeNull();
    expect(week!.reviewed_by).toBeNull();
    expect(week!.submitted_minutes).toBe(150);
  });

  it("refuses to let somebody decide their own week", async () => {
    // The engine checks departmental scope, and a TL is IN the department they
    // lead — so scope alone would let them approve themselves.
    const tl = await signIn("tlVizBytes");
    await reset(tl.userId);

    const ownTask = await makeTask(tl.userId);
    const { error: logError } = await tl.client
      .from("vizserve_pms_timesheet_entries")
      .insert({ user_id: tl.userId, task_id: ownTask, work_date: lastMonday, minutes: 60 });
    expect(logError).toBeNull();

    await tl.client.rpc("vizserve_pms_submit_timesheet_week", { p_week_start: lastMonday });

    const { data: week } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("id")
      .eq("user_id", tl.userId)
      .single();

    const { error } = await tl.client.rpc("vizserve_pms_decide_timesheet_week", {
      p_id: week!.id,
      p_decision: "approved",
      p_reason: null,
    });

    expect(error).not.toBeNull();
    expect((error?.message ?? "").toLowerCase()).toContain("your own");
  });
});

describe.skipIf(!run)("P7-05 — who can see a week", () => {
  beforeAll(async () => {
    if (!run) return;
    const { client } = await signIn("member1VizBytes");
    await reset(picId);
    await logMinutes(client, picId, lastMonday, 120);
    await client.rpc("vizserve_pms_submit_timesheet_week", { p_week_start: lastMonday });
  });

  it("is visible to the department's lead", async () => {
    const tl = await signIn("tlVizBytes");

    const { data } = await tl.client
      .from("vizserve_pms_timesheet_weeks")
      .select("id")
      .eq("user_id", picId);

    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("is invisible to another department's lead — zero rows, not denied", async () => {
    const other = await signIn("tlVizAssists");

    const { data, error } = await other.client
      .from("vizserve_pms_timesheet_weeks")
      .select("id")
      .eq("user_id", picId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("is invisible to a peer in the same department", async () => {
    // Department membership is not department scope. A member sees their own
    // weeks and nobody else's.
    const peer = await signIn("member2VizBytes");

    const { data, error } = await peer.client
      .from("vizserve_pms_timesheet_weeks")
      .select("id")
      .eq("user_id", picId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("refuses anon outright — permission denied, not zero rows", async () => {
    // `anon` holds no table privileges at all. The distinction matters: a
    // missing GRANT and a failing policy are different bugs with different
    // fixes, and conflating them caused an outage here once.
    const { error } = await anonClient().from("vizserve_pms_timesheet_weeks").select("id");

    expect(error).not.toBeNull();
    expect(isPermissionDenied(error)).toBe(true);
  });

  it("cannot be written directly, only through the functions", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_timesheet_weeks")
      .update({ status: "APPROVED" } as never)
      .eq("user_id", picId)
      .select("id");

    // The table has no UPDATE policy, so nothing matches — and an update that
    // matches nothing is SUCCESS WITH ZERO ROWS, not an error. (`permission
    // denied` would mean a missing GRANT, which is a different bug entirely;
    // the blanket grant from P0-06 reaches this table through ALTER DEFAULT
    // PRIVILEGES, so the policy is what stops the write, exactly as intended.)
    //
    // Asserting `error` here was wrong on the first run of this suite. The
    // status is what actually proves the point.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: week } = await adminClient()
      .from("vizserve_pms_timesheet_weeks")
      .select("status")
      .eq("user_id", picId)
      .single();

    // Still SUBMITTED: a status cannot be set without a decision, and therefore
    // never without the matching vizserve_pms_approvals row.
    expect(week!.status).toBe("SUBMITTED");
  });
});
