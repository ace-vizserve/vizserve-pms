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
