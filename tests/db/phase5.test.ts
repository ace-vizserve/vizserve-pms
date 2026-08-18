import { afterAll, describe, expect, it } from "vitest";

import { todayInAppZone, yesterdayInAppZone } from "@/lib/dates";

import { adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

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

    // A wrong, early punch — the exact situation R3 says the user cannot fix,
    // because earliest-in wins permanently.
    await member.client.rpc("vizserve_pms_punch", { p_direction: "in" });

    const { data: before } = await adminClient()
      .from("vizserve_pms_dtr_entries")
      .select("time_in")
      .eq("user_id", member.userId)
      .eq("work_date", today)
      .single();
    expect(before!.time_in).not.toBeNull();

    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Punched in early by mistake.",
      p_work_date: today,
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
      .eq("work_date", today)
      .single();

    expect(after!.time_in).not.toBe(before!.time_in);
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

    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Worked but never tapped in.",
      p_work_date: today,
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
      .eq("work_date", today)
      .single();

    expect(row!.time_in).not.toBeNull();
    expect(row!.time_out).toBeNull();
  });

  it("leaves the DTR alone when the request is rejected", async () => {
    const member = await signIn("member2VizBytes");
    await clearDtr(member.userId);

    const id = await submit(member.client, {
      p_request_type: "NO_TIME_IN",
      p_reason: "Should not be applied.",
      p_work_date: today,
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
      .eq("work_date", today)
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
