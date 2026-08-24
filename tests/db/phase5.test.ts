import { afterAll, describe, expect, it } from "vitest";

import { todayInAppZone, yesterdayInAppZone } from "@/lib/dates";

import { adminClient, dbTestsEnabled, enumValues, signIn, skipReason } from "./helpers";

/**
 * PHASE 5 EXIT CRITERIA — DTR and internal approvals.
 *
 * Every assertion here is one of the six bullets in docs/09. They run as real
 * signed-in users through RLS, not with the service key, because the whole point
 * of "earliest in wins" is that a CLIENT cannot get round it.
 */

/**
 * `process.stderr.write`, NOT `console.warn`.
 *
 * vitest 4 swallows module-level console output entirely — verified with a
 * probe on both a skipped and a passing file. Every db suite in this repo uses
 * `console.warn` here, so all of them have been skipping SILENTLY, which is the
 * exact failure docs/13 calls out: "a suite that skips silently reports green
 * while proving nothing, which is worse than red."
 *
 * Direct stderr survives. The other suites still need this change.
 */
function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`phase5.test.ts — ${skipReason}`);

/**
 * Detected at MODULE LOAD, not in `beforeAll` — `it.skipIf(...)` is evaluated
 * during collection, before any hook runs, so a flag set in a hook is still
 * false at every skip decision. That has gone wrong here once already (docs/13).
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_dtr_entries").select("id").limit(1)).error &&
    !(await adminClient().from("vizserve_pms_internal_requests").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "phase5.test.ts — SKIPPED. The Phase 5 migrations" +
      " (20260804150000_p5_01_dtr.sql, 20260804151000_p5_05_notification_type.sql," +
      " 20260804152000_p5_05_internal_requests.sql) have not been applied to this project." +
      " Apply them in filename order, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

/**
 * P7-04 lands in its own pair of migrations, so it gets its own probe. Testing
 * for the COLUMN rather than the enum value: `overtime_minutes` only exists once
 * the second file has run, and the second file is the one that also rewrites the
 * shape constraint. The enum on its own would let these cases run against a
 * database that cannot store the thing they submit.
 */
const overtimeApplied =
  run
    ? !(await adminClient().from("vizserve_pms_internal_requests").select("overtime_minutes").limit(1))
        .error
    : false;

if (run && !overtimeApplied) {
  announce(
    "phase5.test.ts — P7-04 overtime cases SKIPPED." +
      " supabase/migrations/20260818100100_p7_04_overtime_request.sql is not applied.",
  );
}

/**
 * P7-12 — leave types.
 *
 * Probed on the COLUMN rather than the table, for the same reason the overtime
 * probe above is: the column and the rewritten shape constraint arrive in the
 * same file, and a database with the table but not the constraint would run
 * these cases against rules that are not there yet.
 */
const leaveTypesApplied = run
  ? !(await adminClient().from("vizserve_pms_internal_requests").select("leave_type_id").limit(1))
      .error
  : false;

if (run && !leaveTypesApplied) {
  announce(
    "phase5.test.ts — P7-12 leave-type cases SKIPPED." +
      " supabase/migrations/20260818150000_p7_12_leave_types.sql is not applied.",
  );
}

/**
 * P7-39 — the two off-schedule correction types.
 *
 * ⚠️ NOT PROBED BY FILTERING ON THE LABEL. That is the intuitive test and it is
 * silently wrong: PostgREST returns an empty result and a NULL error for an
 * unknown enum value in a filter, so the probe would report "applied" against a
 * database that has never seen these types. Measured, not assumed — see
 * `enumValues` in ./helpers.
 *
 * Probed on the enum itself, read from PostgREST's schema description. Both
 * files 3 and 4 (p7_38, p7_39) have to be applied for the cases below to mean
 * anything, and there is no column to probe because the new types reuse
 * `work_date` and `correction_at`.
 *
 * WHAT THIS DOES NOT PROVE: that P7-39 ran. A database carrying the enum but not
 * the constraint rewrite passes this and then fails the cases below with a
 * check_violation. That is deliberate — the two files are a pair applied
 * together, so a half-applied pair should be reported loudly rather than
 * skipped into silence.
 */
const timeCorrectionsApplied = run
  ? (await enumValues("vizserve_pms_internal_requests", "request_type")).includes(
      "TIME_IN_CORRECTION",
    )
  : false;

if (run && !timeCorrectionsApplied) {
  announce(
    "phase5.test.ts — P7-39 time-correction cases SKIPPED." +
      " Apply supabase/migrations/20260824140000_p7_38_correction_types.sql then" +
      " 20260824150000_p7_39_time_corrections.sql, in that order.",
  );
}

/**
 * A leave type to file against, resolved once.
 *
 * EVERY EXISTING LEAVE FIXTURE IN THIS FILE NEEDS ONE once P7-12 is applied —
 * the shape constraint makes it required, so a submit without it is refused.
 * That is the whole fixture cost of this slice, and it is test work rather than
 * product work.
 *
 * Null before the migration, and the call sites spread it, so the same fixtures
 * keep working against a database that does not have the column yet.
 */
const leaveType: { p_leave_type_id?: string } = {};

if (leaveTypesApplied) {
  const { data } = await adminClient()
    .from("vizserve_pms_leave_types")
    .select("id")
    .eq("code", "VACATION")
    .single();

  if (data) leaveType.p_leave_type_id = data.id;
}

const today = todayInAppZone();
const yesterday = yesterdayInAppZone();

/** DTR rows are keyed (user, work_date), so tests must clean up after themselves. */
const touchedUsers = new Set<string>();
const createdRequests: string[] = [];

async function clearDtr(userId: string) {
  touchedUsers.add(userId);
  await adminClient().from("vizserve_pms_dtr_entries").delete().eq("user_id", userId);
}

afterAll(async () => {
  if (!run) return;

  // NOTIFICATIONS FIRST, and they were missing entirely until 18 Aug 2026.
  //
  // Submitting a request notifies every lead of the department, and deciding it
  // notifies the requester. This suite does both dozens of times, and it used to
  // delete only the requests — so every run left a drift of notifications
  // pointing at `internal_request` rows that no longer existed.
  //
  // They are not invisible. This project is shared with the running app, so they
  // land in the inbox of whoever is signed in as a test account, outlive the
  // data that explains them, and read as real events: an "OVERTIME request
  // approved" that nobody asked for, attached to a request that cannot be
  // opened. That is a bug report waiting to happen, and it happened.
  //
  // `tests/db/tasks.test.ts` has always done this correctly — the pattern is
  // lifted from there.
  if (createdRequests.length > 0) {
    await adminClient()
      .from("vizserve_pms_notifications")
      .delete()
      .in("entity_id", createdRequests);
  }

  for (const id of createdRequests) {
    await adminClient().from("vizserve_pms_internal_requests").delete().eq("id", id);
  }
  for (const userId of touchedUsers) {
    await adminClient().from("vizserve_pms_dtr_entries").delete().eq("user_id", userId);
  }
});

// ---------------------------------------------------------------------------
// Exit criterion 1 — double punch-in does not change time-in;
//                    double punch-out does update time-out.
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P5-02 — earliest in wins, latest out wins", () => {
  it("keeps the FIRST time-in across repeated punches", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    await clearDtr(userId);

    const first = await client.rpc("vizserve_pms_punch", { p_direction: "in" });
    expect(first.error).toBeNull();
    const firstIn = (first.data as unknown as { time_in: string }).time_in;

    const second = await client.rpc("vizserve_pms_punch", { p_direction: "in" });
    const secondResult = second.data as unknown as { time_in: string; captured: boolean };

    expect(secondResult.time_in).toBe(firstIn);
    // `captured: false` is what the UI uses to say "already timed in" out loud
    // rather than looking like a dead button.
    expect(secondResult.captured).toBe(false);
  });

  it("moves time-out forward on a repeated punch", async () => {
    const { client, userId } = await signIn("member2VizBytes");
    await clearDtr(userId);

    await client.rpc("vizserve_pms_punch", { p_direction: "in" });

    const first = await client.rpc("vizserve_pms_punch", { p_direction: "out" });
    const firstOut = (first.data as unknown as { time_out: string }).time_out;

    // now() is the statement timestamp, so two calls in the same millisecond
    // would tie. A real gap makes "later wins" observable.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const second = await client.rpc("vizserve_pms_punch", { p_direction: "out" });
    const secondOut = (second.data as unknown as { time_out: string }).time_out;

    expect(new Date(secondOut).getTime()).toBeGreaterThan(new Date(firstOut).getTime());
  });

  it("refuses a time-out with no time-in to close", async () => {
    const { client, userId } = await signIn("member1VizAssists");
    await clearDtr(userId);

    const { error } = await client.rpc("vizserve_pms_punch", { p_direction: "out" });
    expect(error?.message ?? "").toContain("no time-in");
  });

  it("refuses a time-in that tries to name a past date", async () => {
    // The backdating hole Q4 exists to close. The client cannot choose the day
    // for a time-in at all.
    const { client, userId } = await signIn("member1VizBytes");
    await clearDtr(userId);

    const { error } = await client.rpc("vizserve_pms_punch", {
      p_direction: "in",
      p_work_date: yesterday,
    });
    expect(error?.message ?? "").toContain("today");
  });

  it("refuses a time-out for a date older than yesterday", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    await clearDtr(userId);

    const { error } = await client.rpc("vizserve_pms_punch", {
      p_direction: "out",
      p_work_date: "2026-01-05",
    });
    expect(error?.message ?? "").toContain("today or yesterday");
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 2 — an OT shift ending 01:00 lands on the PRIOR work date.
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P5-02 — the overnight shift", () => {
  it("closes yesterday's open shift against yesterday, not today", async () => {
    const { client, userId } = await signIn("member2VizBytes");
    await clearDtr(userId);

    // Amier's worked example: in 22:00 on the 22nd, out 01:00 on the 23rd, and
    // the record must belong to the 22nd or that day shows no time-out at all.
    // Seeded directly because the punch endpoint only ever writes now().
    await adminClient()
      .from("vizserve_pms_dtr_entries")
      .insert({
        user_id: userId,
        work_date: yesterday,
        time_in: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      });

    const { data, error } = await client.rpc("vizserve_pms_punch", {
      p_direction: "out",
      p_work_date: yesterday,
    });

    expect(error).toBeNull();
    const result = data as unknown as { work_date: string; time_out: string };
    expect(result.work_date).toBe(yesterday);
    expect(result.time_out).not.toBeNull();

    // And today must not have been created as a side effect.
    const { data: todayRow } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("id")
      .eq("user_id", userId)
      .eq("work_date", today)
      .maybeSingle();
    expect(todayRow).toBeNull();
  });

  it("refuses to reopen yesterday once it is closed", async () => {
    const { client, userId } = await signIn("member1VizAssists");
    await clearDtr(userId);

    const start = new Date(Date.now() - 4 * 3_600_000).toISOString();
    await adminClient()
      .from("vizserve_pms_dtr_entries")
      .insert({
        user_id: userId,
        work_date: yesterday,
        time_in: start,
        time_out: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      });

    const { error } = await client.rpc("vizserve_pms_punch", {
      p_direction: "out",
      p_work_date: yesterday,
    });
    expect(error?.message ?? "").toContain("already closed");
  });

  it("refuses a time-out on a shift left open more than 18 hours", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    await clearDtr(userId);

    await adminClient()
      .from("vizserve_pms_dtr_entries")
      .insert({
        user_id: userId,
        work_date: today,
        time_in: new Date(Date.now() - 20 * 3_600_000).toISOString(),
      });

    const { error } = await client.rpc("vizserve_pms_punch", { p_direction: "out" });
    expect(error?.message ?? "").toContain("18 hours");
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 3 — all four internal request types submit and route.
// ---------------------------------------------------------------------------

async function submit(
  client: Awaited<ReturnType<typeof signIn>>["client"],
  args: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", args as never);
  if (error) throw new Error(error.message);
  const id = (data as unknown as { id: string }).id;
  createdRequests.push(id);
  return id;
}

describe.skipIf(!run)("P5-06 / P5-07 — the four types route to the right queue", () => {
  it("accepts all four and routes them to the requester's department", async () => {
    const { client, userId } = await signIn("member1VizBytes");

    const ids = await Promise.all([
      submit(client, {
        p_request_type: "LEAVE",
        p_reason: "Family matters.",
        p_start_date: today,
        p_end_date: today,
        ...leaveType,
      }),
      submit(client, {
        p_request_type: "NO_TIME_IN",
        p_reason: "Badge reader was down.",
        p_work_date: yesterday,
        p_correction_time: "08:00",
      }),
      submit(client, {
        p_request_type: "NO_TIME_OUT",
        p_reason: "Forgot to tap out.",
        p_work_date: yesterday,
        p_correction_time: "18:00",
      }),
      submit(client, {
        p_request_type: "REIMBURSEMENT",
        p_reason: "Taxi to the client site.",
        p_amount: 450.5,
      }),
    ]);

    expect(ids).toHaveLength(4);

    const { data: rows } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("request_type, department_id, status, requester_id")
      .in("id", ids);

    const { data: user } = await adminClient()
      .from("vizserve_pms_users")
      .select("primary_department_id")
      .eq("id", userId)
      .single();

    expect(rows).toHaveLength(4);
    for (const row of rows ?? []) {
      expect(row.status).toBe("PENDING_REVIEW");
      // P5-07: routing comes from the requester's record, never the client.
      expect(row.department_id).toBe(user!.primary_department_id);
    }
  });

  it("appears in the leading TL's queue and nobody else's", async () => {
    const { client } = await signIn("member1VizBytes");
    const id = await submit(client, {
      p_request_type: "LEAVE",
      p_reason: "Scoping the queue test.",
      p_start_date: today,
      p_end_date: today,
      ...leaveType,
    });

    const tl = await signIn("tlVizBytes");
    const { data: visible } = await tl.client
      .from("vizserve_pms_internal_requests")
      .select("id")
      .eq("id", id);
    expect(visible).toHaveLength(1);

    // A team leader of a DIFFERENT department gets zero rows — a working
    // policy, not an error.
    const other = await signIn("tlVizMedia");
    const { data: hidden, error } = await other.client
      .from("vizserve_pms_internal_requests")
      .select("id")
      .eq("id", id);
    expect(error).toBeNull();
    expect(hidden).toHaveLength(0);
  });

  it("refuses a shape that does not match its type", async () => {
    const { client } = await signIn("member1VizBytes");
    // A leave request with no dates. The CHECK constraint is the authority here,
    // not the zod schema a direct API call never runs.
    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "No dates supplied.",
    } as never);
    expect(error).not.toBeNull();
  });

  it("does not let anyone decide their own request", async () => {
    // A team leader IS in the department they lead, so scope alone would let
    // them approve their own leave.
    const tl = await signIn("tlVizBytes");
    const id = await submit(tl.client, {
      p_request_type: "LEAVE",
      p_reason: "Self-approval attempt.",
      p_start_date: today,
      p_end_date: today,
      ...leaveType,
    });

    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error?.message ?? "").toContain("your own");
  });

  it("requires a reason to reject", async () => {
    const { client } = await signIn("member1VizBytes");
    const id = await submit(client, {
      p_request_type: "LEAVE",
      p_reason: "Reason-required test.",
      p_start_date: today,
      p_end_date: today,
      ...leaveType,
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "rejected",
    });
    // Enforced by the ENGINE, not by this consumer — which is the point.
    expect(error?.message ?? "").toContain("reason is required");
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 4 — an approved No Time-In ACTUALLY corrects the DTR.
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P5-09 — approval writes the correction into the DTR", () => {
  it("overwrites an unoverwritable time-in", async () => {
    const member = await signIn("member1VizBytes");
    await clearDtr(member.userId);

    /*
     * YESTERDAY, AND SEEDED RATHER THAN PUNCHED — clock independence, the same
     * fix `4e0caea` made to the shift-inversion test below.
     *
     * This used to punch in on `today` and then correct today at 09:30.
     * Submission refuses a time that has not happened yet, so the test passed
     * between 09:30 and midnight Manila and failed every other hour — it was
     * found failing at 01:40. Nothing about the rule under test needs today:
     * what is being proved is that an approved correction overwrites an
     * earliest-in that R3 says the user cannot fix, and yesterday proves it
     * just as well while keeping 09:30 firmly in the past.
     *
     * Seeding through the service role rather than punching is the other half.
     * `vizserve_pms_punch` can only ever write TODAY — it reads the Manila clock
     * itself — so a punch cannot produce yesterday's row at all.
     */
    const before = { time_in: `${yesterday}T00:15:00Z` }; // 08:15 Manila

    await adminClient().from("vizserve_pms_dtr_entries").insert({
      user_id: member.userId,
      work_date: yesterday,
      time_in: before.time_in,
    });

    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Punched in early by mistake.",
      p_work_date: yesterday,
      p_correction_time: "09:30",
    });

    const tl = await signIn("tlVizBytes");
    const { data, error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();
    expect((data as unknown as { dtr_entry_id: string | null }).dtr_entry_id).not.toBeNull();

    const { data: after } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_in, corrected_at, corrected_by, correction_request_id")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .single();

    expect(after!.time_in).not.toBe(before.time_in);
    // 09:30 Manila is 01:30 UTC.
    expect(new Date(after!.time_in!).toISOString()).toContain("T01:30");
    // Provenance: the row must say it was corrected, and by which request.
    expect(after!.corrected_at).not.toBeNull();
    expect(after!.corrected_by).toBe(tl.userId);
    expect(after!.correction_request_id).toBe(id);
  });

  it("creates the row when the day was never punched at all", async () => {
    const member = await signIn("member1VizAssists");
    await clearDtr(member.userId);

    // Yesterday, for the same reason as above: 07:45 has not happened yet if the
    // suite runs before 07:45, and "the day was never punched" is equally true
    // of yesterday.
    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Worked but never tapped in.",
      p_work_date: yesterday,
      p_correction_time: "07:45",
    });

    const tl = await signIn("tlVizAssists");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();

    const { data: row } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_in, time_out")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .single();

    expect(row!.time_in).not.toBeNull();
    expect(row!.time_out).toBeNull();
  });

  it("leaves the DTR alone when the request is rejected", async () => {
    const member = await signIn("member2VizBytes");
    await clearDtr(member.userId);

    // Yesterday again. 06:00 is in the future for any run before dawn, and the
    // rule under test — a rejection writes nothing — does not care which day.
    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Should not be applied.",
      p_work_date: yesterday,
      p_correction_time: "06:00",
    });

    const tl = await signIn("tlVizBytes");
    await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "rejected",
      p_reason: "No supporting evidence.",
    });

    const { data: row } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("id")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .maybeSingle();

    expect(row).toBeNull();
  });

  it("refuses a correction that would invert the shift", async () => {
    const member = await signIn("member2VizBytes");
    await clearDtr(member.userId);

    // Yesterday, not today. The correction time below is 23:00, and submission
    // refuses a time that has not happened yet — so on `today` this test only
    // passed when the suite happened to run after 23:00 Manila, and failed
    // every other hour of the day. Dating it to yesterday keeps 23:00 firmly in
    // the past while still inverting the shift, which is the rule under test.
    await adminClient()
      .from("vizserve_pms_dtr_entries")
      .insert({
        user_id: member.userId,
        work_date: yesterday,
        time_in: `${yesterday}T00:00:00Z`,
        time_out: `${yesterday}T02:00:00Z`, // 10:00 Manila
      });

    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Time-in after the recorded time-out.",
      p_work_date: yesterday,
      p_correction_time: "23:00",
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    // A sentence, not a constraint name.
    expect(error?.message ?? "").toContain("after the recorded time-out");
  });
});

// ---------------------------------------------------------------------------
// Exit criterion 5 — RLS on the DTR, and no direct writes.
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P5-01 — the DTR cannot be hand-edited", () => {
  it("refuses a direct insert even by an admin", async () => {
    // No INSERT policy exists, so this is a policy denial rather than a grant
    // failure. It is what makes "earliest in wins" a rule instead of a habit.
    const admin = await signIn("admin");
    const { error } = await admin.client
      .from("vizserve_pms_dtr_entries")
      .insert({ user_id: admin.userId, work_date: "2026-01-02", time_in: "2026-01-02T00:00:00Z" });

    expect(error).not.toBeNull();
  });

  it("hides one member's DTR from another member", async () => {
    const owner = await signIn("member1VizBytes");
    await clearDtr(owner.userId);
    await owner.client.rpc("vizserve_pms_punch", { p_direction: "in" });

    const other = await signIn("member2VizBytes");
    const { data, error } = await other.client
      .from("vizserve_pms_dtr_entries")
      .select("id")
      .eq("user_id", owner.userId);

    // Zero rows from a working policy, not `permission denied`.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("shows a team leader their department's DTR", async () => {
    const owner = await signIn("member1VizBytes");
    await clearDtr(owner.userId);
    await owner.client.rpc("vizserve_pms_punch", { p_direction: "in" });

    const tl = await signIn("tlVizBytes");
    const { data } = await tl.client
      .from("vizserve_pms_dtr_entries")
      .select("id")
      .eq("user_id", owner.userId);

    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P7-04 — OVERTIME, the fifth type.
//
// The first type added since launch, so these cases carry a second job beyond
// "does overtime work": they prove the per-type CHECK actually discriminates
// now. Its old `else` branch swallowed any new enum value into the time
// correction shape, which would have made this type quietly unusable.
// ---------------------------------------------------------------------------
describe.skipIf(!overtimeApplied)("P7-04 — overtime requests", () => {
  it("submits and routes like every other type", async () => {
    const { client, userId } = await signIn("member1VizBytes");

    const id = await submit(client, {
      p_request_type: "OVERTIME",
      p_reason: "Client deadline moved to Friday.",
      p_work_date: yesterday,
      p_overtime_minutes: 120,
    });

    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("request_type, status, department_id, work_date, overtime_minutes, amount")
      .eq("id", id)
      .single();

    const { data: user } = await adminClient()
      .from("vizserve_pms_users")
      .select("primary_department_id")
      .eq("id", userId)
      .single();

    expect(row!.request_type).toBe("OVERTIME");
    expect(row!.status).toBe("PENDING_REVIEW");
    expect(row!.department_id).toBe(user!.primary_department_id);
    expect(row!.overtime_minutes).toBe(120);
    expect(row!.amount).toBeNull();
  });

  it("accepts today, because you ask before you work the evening", async () => {
    const { client } = await signIn("member1VizBytes");

    const id = await submit(client, {
      p_request_type: "OVERTIME",
      p_reason: "Staying late to finish the deck.",
      p_work_date: today,
      p_overtime_minutes: 90,
    });

    expect(id).toBeTruthy();
  });

  it("refuses a future day", async () => {
    const { client } = await signIn("member1VizBytes");
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);

    await expect(
      submit(client, {
        p_request_type: "OVERTIME",
        p_reason: "Planning ahead a little too far.",
        p_work_date: tomorrow,
        p_overtime_minutes: 60,
      }),
    ).rejects.toThrow();
  });

  it("refuses a day or a length that is missing", async () => {
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "OVERTIME",
        p_reason: "No day given.",
        p_overtime_minutes: 60,
      }),
    ).rejects.toThrow();

    await expect(
      submit(client, {
        p_request_type: "OVERTIME",
        p_reason: "No length given.",
        p_work_date: yesterday,
      }),
    ).rejects.toThrow();
  });

  it("refuses more overtime than a day can hold", async () => {
    // 960 is not arbitrary: 480 + 960 is exactly the 1440-minute day cap the
    // timesheet trigger enforces. Above it, an approved request would describe
    // a day the database will not accept entries for.
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "OVERTIME",
        p_reason: "A very long evening indeed.",
        p_work_date: yesterday,
        p_overtime_minutes: 961,
      }),
    ).rejects.toThrow();
  });

  it("refuses fields that belong to another type", async () => {
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "OVERTIME",
        p_reason: "Overtime is not a reimbursement.",
        p_work_date: yesterday,
        p_overtime_minutes: 60,
        p_amount: 500,
      }),
    ).rejects.toThrow();
  });

  it("keeps overtime_minutes off the other types", async () => {
    // The other half of the constraint rewrite. If this passes, the branches
    // are discriminating rather than falling through to a common shape.
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "NO_TIME_IN",
        p_reason: "A correction carrying overtime it has no use for.",
        p_work_date: yesterday,
        p_correction_time: "08:00",
        p_overtime_minutes: 60,
      }),
    ).rejects.toThrow();
  });

  it("approving one writes nothing into the DTR", async () => {
    // Deliberate. An approved OT row is a fact the timesheet and payroll READ.
    // Copying it into the DTR would be a second source of truth for the same
    // hours, and the two would disagree the first time somebody worked less
    // overtime than they asked for.
    const { client } = await signIn("member1VizBytes");
    const id = await submit(client, {
      p_request_type: "OVERTIME",
      p_reason: "Checking the side effects, of which there are none.",
      p_work_date: yesterday,
      p_overtime_minutes: 60,
    });

    const tl = await signIn("tlVizBytes");
    const { data, error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
      p_reason: null,
    });

    expect(error).toBeNull();
    expect((data as unknown as { dtr_entry_id: string | null }).dtr_entry_id).toBeNull();

    // And the engine was used rather than reimplemented.
    const { data: approvals } = await adminClient()
      .from("vizserve_pms_approvals")
      .select("decision, entity_type")
      .eq("entity_id", id);

    expect(approvals).toHaveLength(1);
    expect(approvals![0]!.entity_type).toBe("internal_request");
    expect(approvals![0]!.decision).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// The queries the DTR screens actually send.
//
// These assert something the rest of the suite never did: that the SELECT
// STRING PARSES. `vizserve_pms_dtr_entries` has two foreign keys to
// `vizserve_pms_users` — `user_id` and `corrected_by` — so an unqualified
// embed is ambiguous and PostgREST refuses the entire query.
//
// That is not a hypothetical. The list page and the payroll export both shipped
// with the ambiguous form. The page read `data ?? []` and rendered "No entries
// in this range", so a total failure was indistinguishable from an empty record
// and it went unnoticed until the error was put on screen.
//
// Row counts are deliberately not asserted — the point is that the shape is
// accepted, which is the part that was broken and the part no other test
// covers.
// ---------------------------------------------------------------------------
describe.skipIf(!run)("the DTR queries parse", () => {
  const USER_FK = "vizserve_pms_users!vizserve_pms_dtr_entries_user_id_fkey";

  it("the list page's select is unambiguous", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client
      .from("vizserve_pms_dtr_entries")
      .select(`id, work_date, time_in, time_out, corrected_at, user_id, ${USER_FK}(full_name)`)
      .gte("work_date", "2026-01-01")
      .lte("work_date", today)
      .limit(1);

    expect(error).toBeNull();
  });

  it("the payroll export's select is unambiguous", async () => {
    const { client } = await signIn("tlVizBytes");

    const { error } = await client
      .from("vizserve_pms_dtr_entries")
      .select(`work_date, time_in, time_out, corrected_at, user_id, ${USER_FK}(full_name, email)`)
      .gte("work_date", "2026-01-01")
      .lte("work_date", today)
      .limit(1);

    expect(error).toBeNull();
  });

  it("proves the unqualified embed is genuinely refused", async () => {
    // Pins WHY the constraint has to be named. If a future migration drops
    // `corrected_by`, this starts passing and the hint becomes optional — but
    // the hint is still correct, so this test failing is information, not an
    // instruction to remove anything.
    const { client } = await signIn("member1VizBytes");

    const { error } = await client
      .from("vizserve_pms_dtr_entries")
      .select("id, vizserve_pms_users(full_name)")
      .limit(1);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("more than one relationship");
  });
});

// ---------------------------------------------------------------------------
// P7-12 — leave types.
// ---------------------------------------------------------------------------

describe.skipIf(!leaveTypesApplied)("P7-12 — leave types", () => {
  it("seeded Amier's list, active and ordered", async () => {
    const { data } = await adminClient()
      .from("vizserve_pms_leave_types")
      .select("code, label, is_active")
      .order("sort_order");

    expect(data!.map((row) => row.code)).toEqual([
      "VACATION",
      "SICK",
      "SERVICE_INCENTIVE",
      "BIRTHDAY",
      "MATERNITY",
      "PATERNITY",
      "SOLO_PARENT",
      "SPECIAL_WOMEN",
    ]);

    // Order is by usage, not alphabet. Vacation and Sick are what almost
    // everybody picks, and alphabetically Sick lands seventh.
    expect(data![0]!.label).toBe("Vacation Leave");
    expect(data!.every((row) => row.is_active)).toBe(true);
  });

  it("refuses a leave request with no type", async () => {
    // The constraint is the authority, not the zod schema a direct API call
    // never runs.
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "No type supplied.",
      p_start_date: today,
      p_end_date: today,
    } as never);

    expect(error).not.toBeNull();
  });

  it("records the type it was filed under", async () => {
    const { client } = await signIn("member1VizBytes");
    const { data: sick } = await adminClient()
      .from("vizserve_pms_leave_types")
      .select("id")
      .eq("code", "SICK")
      .single();

    const id = await submit(client, {
      p_request_type: "LEAVE",
      p_reason: "Down with something.",
      p_start_date: today,
      p_end_date: today,
      p_leave_type_id: sick!.id,
    });

    const { data: request } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("leave_type_id")
      .eq("id", id)
      .single();

    expect(request!.leave_type_id).toBe(sick!.id);
  });

  it("refuses a retired type on a NEW request but keeps it on old ones", async () => {
    // The entire reason this is a table and not an enum: a type can stop being
    // offered without orphaning the requests that already used it.
    const admin = adminClient();
    const { data: type } = await admin
      .from("vizserve_pms_leave_types")
      .insert({ code: `TEMP_${Math.random().toString(36).slice(2, 8)}`, label: "Temporary" })
      .select("id")
      .single();

    const { client } = await signIn("member1VizBytes");
    const existing = await submit(client, {
      p_request_type: "LEAVE",
      p_reason: "Filed while the type was live.",
      p_start_date: today,
      p_end_date: today,
      p_leave_type_id: type!.id,
    });

    await admin.from("vizserve_pms_leave_types").update({ is_active: false }).eq("id", type!.id);

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Filed after it was retired.",
      p_start_date: today,
      p_end_date: today,
      p_leave_type_id: type!.id,
    } as never);

    expect(error?.message ?? "").toContain("no longer available");

    // The old one is untouched and still points at the retired type.
    const { data: kept } = await admin
      .from("vizserve_pms_internal_requests")
      .select("leave_type_id")
      .eq("id", existing)
      .single();

    expect(kept!.leave_type_id).toBe(type!.id);

    await admin.from("vizserve_pms_internal_requests").delete().eq("id", existing);
    await admin.from("vizserve_pms_leave_types").delete().eq("id", type!.id);
  });

  it("refuses to delete a type that is in use", async () => {
    // `on delete restrict`. A cascade here would silently rewrite history the
    // first time an admin tidied the list.
    const { client } = await signIn("member1VizBytes");
    const id = await submit(client, {
      p_request_type: "LEAVE",
      p_reason: "Holding a reference.",
      p_start_date: today,
      p_end_date: today,
      ...leaveType,
    });

    const { error } = await adminClient()
      .from("vizserve_pms_leave_types")
      .delete()
      .eq("id", leaveType.p_leave_type_id!);

    expect(error).not.toBeNull();
    expect(await Promise.resolve(id)).toBeTruthy();
  });

  it("forbids a type on every other request kind", async () => {
    // The shape constraint's other half. A reimbursement carrying a leave type
    // is a row nobody can interpret.
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "REIMBURSEMENT",
      p_reason: "Taxi to the client site.",
      p_amount: 450,
      p_leave_type_id: leaveType.p_leave_type_id,
    } as never);

    // The function coerces it to null rather than refusing, so this SUCCEEDS —
    // and the row must come back with no type on it. Refusing would give a
    // worse message for a field the client had no business sending.
    expect(error).toBeNull();

    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("id, leave_type_id")
      .eq("requester_id", (await signIn("member1VizBytes")).userId)
      .eq("request_type", "REIMBURSEMENT")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    expect(row!.leave_type_id).toBeNull();
    createdRequests.push(row!.id);
  });

  it("is readable by any signed-in user and writable by none of them", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client.from("vizserve_pms_leave_types").select("id, label");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);

    // Admin-only writes, the same shape as vizserve_pms_holidays.
    const { data: written } = await client
      .from("vizserve_pms_leave_types")
      .update({ label: "Hijacked" })
      .eq("code", "VACATION")
      .select("id");

    expect(written ?? []).toHaveLength(0);
  });

  it("does not leak the type through the leave calendar", async () => {
    // P7-10 withholds the reason because a reason is medical or personal. Four
    // of the eight types are disclosures in their own right — Sick, Maternity,
    // Solo Parent and Special Leave for Women. The calendar returns four
    // columns and this is the test that keeps it at four.
    const { client } = await signIn("member1VizBytes");

    const { data } = await client.rpc("vizserve_pms_leave_calendar", {
      p_from: today,
      p_to: today,
    });

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(["end_date", "full_name", "start_date", "user_id"]);
    }
  });
});

// ---------------------------------------------------------------------------
// P7-39 — TIME_IN_CORRECTION / TIME_OUT_CORRECTION.
//
// The payload and the DTR write-back are identical to the NO_TIME_* pair, so
// what these cases actually prove is that the widening landed in ALL SEVEN
// places inside vizserve_pms_decide_internal_request. Six of the seven fail
// loudly if missed; the four `case` expressions inside the upsert do not — they
// have no `else`, so a missed one yields null, the upsert writes the existing
// time straight back, and the approval still reports success with a non-null
// dtr_entry_id. That is the failure these cases exist to catch.
// ---------------------------------------------------------------------------

describe.skipIf(!run || !timeCorrectionsApplied)("P7-39 — off-schedule corrections", () => {
  it("overwrites a recorded time-in", async () => {
    const member = await signIn("member1VizBytes");
    await clearDtr(member.userId);

    // Yesterday and seeded, for the clock-independence reason P5-09 records: a
    // correction to a time that has not happened yet is refused, so a test
    // written against today passes only after that time of day.
    const recorded = `${yesterday}T01:26:00Z`; // 09:26 Manila — late.

    await adminClient().from("vizserve_pms_dtr_entries").insert({
      user_id: member.userId,
      work_date: yesterday,
      time_in: recorded,
    });

    const id = await submit(member.client, {
      p_request_type: "TIME_IN_CORRECTION",
      p_reason: "Started at nine, clocked in once I reached a machine.",
      p_work_date: yesterday,
      p_correction_time: "09:00",
    });

    const tl = await signIn("tlVizBytes");
    const { data, error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();
    expect((data as unknown as { dtr_entry_id: string | null }).dtr_entry_id).not.toBeNull();

    const { data: after } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_in, corrected_at, corrected_by, correction_request_id")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .single();

    // ⚠️ The assertion that catches a missed `case` site. Without it the row
    // still has corrected_at, corrected_by and correction_request_id set, and
    // every other expectation in this test passes.
    expect(after!.time_in).not.toBe(recorded);
    expect(new Date(after!.time_in!).toISOString()).toContain("T01:00");
    expect(after!.corrected_by).toBe(tl.userId);
    expect(after!.correction_request_id).toBe(id);
  });

  it("moves a time-out LATER", async () => {
    const member = await signIn("member2VizBytes");
    await clearDtr(member.userId);

    await adminClient().from("vizserve_pms_dtr_entries").insert({
      user_id: member.userId,
      work_date: yesterday,
      time_in: `${yesterday}T01:00:00Z`, // 09:00 Manila
      time_out: `${yesterday}T09:00:00Z`, // 17:00 Manila
    });

    const id = await submit(member.client, {
      p_request_type: "TIME_OUT_CORRECTION",
      p_reason: "Worked until six, clocked out on the way past at five.",
      p_work_date: yesterday,
      p_correction_time: "18:00",
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_in, time_out")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .single();

    expect(new Date(after!.time_out!).toISOString()).toContain("T10:00");
    // The other end is untouched. A correction fixes ONE time.
    expect(new Date(after!.time_in!).toISOString()).toContain("T01:00");
  });

  it("moves a time-out EARLIER — the write vizserve_pms_punch refuses", async () => {
    /*
     * ⚠️ THE CASE THAT PROVES THE UPSERT IS ASSIGNED AND NOT PROTECTED.
     *
     * vizserve_pms_punch closes a shift with `greatest(coalesce(time_out, now),
     * now)`, so it can only ever move a time-out later. If that idiom — or a
     * coalesce — ever gets copied into the correction path, THIS is the only
     * case that fails: every other test here moves a time later or fills a
     * blank, and all of them would still pass.
     */
    const member = await signIn("member1VizAssists");
    await clearDtr(member.userId);

    await adminClient().from("vizserve_pms_dtr_entries").insert({
      user_id: member.userId,
      work_date: yesterday,
      time_in: `${yesterday}T01:00:00Z`, // 09:00 Manila
      time_out: `${yesterday}T13:00:00Z`, // 21:00 Manila — clocked out far too late
    });

    const id = await submit(member.client, {
      p_request_type: "TIME_OUT_CORRECTION",
      p_reason: "Left at six, forgot to clock out until I got home.",
      p_work_date: yesterday,
      p_correction_time: "18:00",
    });

    const tl = await signIn("tlVizAssists");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_out")
      .eq("user_id", member.userId)
      .eq("work_date", yesterday)
      .single();

    // 18:00 Manila is 10:00 UTC. A greatest() would have left this at 13:00.
    expect(new Date(after!.time_out!).toISOString()).toContain("T10:00");
  });

  it("still refuses a time-out earlier than the recorded time-in", async () => {
    // The ordering guard has to follow the new types too, and it has to speak a
    // sentence rather than a constraint name.
    const member = await signIn("member1VizBytes");
    await clearDtr(member.userId);

    await adminClient().from("vizserve_pms_dtr_entries").insert({
      user_id: member.userId,
      work_date: yesterday,
      time_in: `${yesterday}T05:00:00Z`, // 13:00 Manila
    });

    const id = await submit(member.client, {
      p_request_type: "TIME_OUT_CORRECTION",
      p_reason: "Trying to close it at an impossible hour.",
      p_work_date: yesterday,
      p_correction_time: "09:00",
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("before the recorded time-in");
  });

  it("keeps the other types' fields off a correction", async () => {
    // Proves the two new CHECK branches discriminate rather than falling
    // through into a branch that tolerates anything — the exact regression
    // p7_04's `else false` was written to prevent.
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "TIME_IN_CORRECTION",
        p_reason: "A correction carrying an amount.",
        p_work_date: yesterday,
        p_correction_time: "09:00",
        p_amount: 500,
      }),
    ).rejects.toThrow();

    await expect(
      submit(client, {
        p_request_type: "TIME_OUT_CORRECTION",
        p_reason: "A correction carrying overtime minutes.",
        p_work_date: yesterday,
        p_correction_time: "18:00",
        p_overtime_minutes: 120,
      }),
    ).rejects.toThrow();
  });

  it("demands both the day and the time", async () => {
    // Proves the one-line widening in the submit function landed. Without it
    // v_correction stays null and the error is a constraint name.
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "TIME_IN_CORRECTION",
        p_reason: "No time given at all.",
        p_work_date: yesterday,
      }),
    ).rejects.toThrow(/needs the date and the time/);
  });

  it("refuses a correction to a time that has not happened yet", async () => {
    const { client } = await signIn("member1VizBytes");

    await expect(
      submit(client, {
        p_request_type: "TIME_IN_CORRECTION",
        p_reason: "Correcting tomorrow, somehow.",
        p_work_date: today,
        p_correction_time: "23:59",
      }),
    ).rejects.toThrow(/has not happened yet/);
  });
});
