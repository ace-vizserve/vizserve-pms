import { afterAll, describe, expect, it } from "vitest";

import { DEPARTMENTS, adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P7-16 — leave starts and ends on a HALF of a day.
 *
 * `tests/unit/leave-halves.test.ts` already covers the zod contract and the
 * display helper. This file covers the two enforcement points a unit test cannot
 * reach, and the migration is explicit that there are three copies of the same
 * rule that have to agree:
 *
 *   * the CHECK constraint  — reached by a direct INSERT, bypassing the function
 *   * the raised sentence   — reached through the submit RPC
 *
 * The distinction matters. A constraint violation reads as a constraint NAME,
 * which is why the function raises its own sentence first; if the function ever
 * stopped raising, the request would still be refused and the user would still
 * be stuck, so both are asserted separately rather than one standing in for the
 * other.
 *
 * The dates below are FIXED AND FUTURE, never `today`. Three cases in
 * `phase5.test.ts` passed only after their own hour because they were written
 * against the clock (docs/13), and leave has no not-in-the-future rule, so there
 * is nothing to gain by dating these dynamically.
 */

/** `process.stderr.write`, not `console.warn` — vitest 4 swallows the latter at module level. */
function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`leave-halves.test.ts — ${skipReason}`);

/**
 * Detected at MODULE LOAD. `it.skipIf(...)` is evaluated during collection,
 * before any hook runs, so a flag set in `beforeAll` is still false at every
 * skip decision and the whole file skips silently even once the migration is in.
 *
 * Probed on `start_half` rather than on the enum type: the column, the rewritten
 * shape constraint and the eleven-argument function all arrive in the same file,
 * so the column's presence is the honest signal that the RULES are there too.
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_internal_requests").select("start_half").limit(1))
      .error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "leave-halves.test.ts — SKIPPED." +
      " supabase/migrations/20260819090000_p7_16_leave_halves.sql is not applied to this project." +
      " Apply it in the dashboard SQL editor, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

/**
 * A leave type to file against — P7-12 made one mandatory, so every fixture here
 * needs it and a null would be refused by the shape constraint rather than by
 * anything this file is testing.
 */
let leaveTypeId = "";

if (run) {
  const { data } = await adminClient()
    .from("vizserve_pms_leave_types")
    .select("id")
    .eq("code", "VACATION")
    .single();
  leaveTypeId = data?.id ?? "";

  if (!leaveTypeId) {
    announce(
      "leave-halves.test.ts — no VACATION leave type seeded." +
        " Apply supabase/migrations/20260818150000_p7_12_leave_types.sql.",
    );
  }
}

const createdRequests: string[] = [];

/**
 * Submitting notifies every lead of the department, and those notifications
 * outlive the request unless they are deleted first — this project is shared
 * with the running app, so a stale one lands in a real inbox pointing at a
 * request that can no longer be opened. That has already been reported as a bug
 * once (docs/13). Notifications first, then the rows.
 */
afterAll(async () => {
  if (!run || createdRequests.length === 0) return;

  const admin = adminClient();
  await admin.from("vizserve_pms_notifications").delete().in("entity_id", createdRequests);
  await admin.from("vizserve_pms_internal_requests").delete().in("id", createdRequests);
});

type Client = Awaited<ReturnType<typeof signIn>>["client"];

/** Submits through the RPC and records the id for cleanup. */
async function submitLeave(client: Client, args: Record<string, unknown>): Promise<string> {
  const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
    p_request_type: "LEAVE",
    p_reason: "Filed by the P7-16 suite.",
    p_leave_type_id: leaveTypeId,
    ...args,
  } as never);

  if (error) throw new Error(`fixture leave: ${error.message}`);

  const id = (data as unknown as { id: string }).id;
  createdRequests.push(id);
  return id;
}

/**
 * A row written straight into the table with the service key.
 *
 * THIS IS THE ONLY WAY TO REACH THE CONSTRAINT. The service role bypasses
 * policies but not CHECKs, so an insert here runs the shape rule with the
 * function — and its sentence — entirely out of the way. Returns the error so a
 * caller can assert on it.
 */
async function insertRaw(row: Record<string, unknown>) {
  const { userId } = await signIn("member1VizBytes");

  const { data, error } = await adminClient()
    .from("vizserve_pms_internal_requests")
    .insert({
      requester_id: userId,
      department_id: DEPARTMENTS.VizBytes,
      reason: "Written directly by the P7-16 suite.",
      ...row,
    } as never)
    .select("id")
    .maybeSingle();

  if (data?.id) createdRequests.push(data.id);
  return { id: data?.id ?? null, error };
}

async function rowOf(id: string) {
  const { data } = await adminClient()
    .from("vizserve_pms_internal_requests")
    .select("request_type, start_date, end_date, start_half, end_half, status")
    .eq("id", id)
    .single();
  return data!;
}

// ---------------------------------------------------------------------------
// The defaults, which are what every request meant before this shipped
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — the default span", () => {
  it("fills MORNING to AFTERNOON when the client sends no halves at all", async () => {
    const { client } = await signIn("member1VizBytes");
    const id = await submitLeave(client, {
      p_start_date: "2026-12-03",
      p_end_date: "2026-12-05",
    });

    // A whole span, which is exactly what a two-date request meant before the
    // columns existed. Anything else would change the meaning of every form
    // that has not been updated to send them.
    expect(await rowOf(id)).toMatchObject({ start_half: "MORNING", end_half: "AFTERNOON" });
  });

  it("resolves to ONE function, not two — the old nine-argument overload is gone", async () => {
    /*
     * TRAP 3 IN THE MIGRATION, asserted rather than trusted.
     *
     * PostgREST resolves overloads by argument NAME. Had `create or replace`
     * been used instead of drop-and-recreate, the nine-argument version would
     * still be live beside the eleven-argument one, and THIS payload — which
     * names exactly the old nine — would match both. PostgREST answers an
     * ambiguous match with PGRST203 "Could not choose the best candidate
     * function" rather than picking one.
     *
     * So a clean success proves exactly one candidate matched, and the halves
     * coming back filled prove it was the new one. A request routing silently
     * to the old function and dropping its halves is the failure this catches.
     */
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Nine-argument payload, as an un-updated client would send it.",
      p_start_date: "2026-12-08",
      p_end_date: "2026-12-09",
      p_work_date: null,
      p_correction_time: null,
      p_amount: null,
      p_overtime_minutes: null,
      p_leave_type_id: leaveTypeId,
    } as never);

    expect(error).toBeNull();

    const id = (data as unknown as { id: string }).id;
    createdRequests.push(id);
    expect(await rowOf(id)).toMatchObject({ start_half: "MORNING", end_half: "AFTERNOON" });
  });
});

// ---------------------------------------------------------------------------
// What the halves are allowed to say
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — legal spans", () => {
  it("stores half a day at either end of a multi-day span", async () => {
    // The ordinary shape: away after lunch on the 3rd, back after lunch on the
    // 5th. Afternoon-to-morning is legal here and meaningless within one day,
    // which is the whole of the rule below.
    const { client } = await signIn("member1VizBytes");
    const id = await submitLeave(client, {
      p_start_date: "2026-12-03",
      p_end_date: "2026-12-05",
      p_start_half: "AFTERNOON",
      p_end_half: "MORNING",
    });

    expect(await rowOf(id)).toMatchObject({ start_half: "AFTERNOON", end_half: "MORNING" });
  });

  it("stores a single morning and a single afternoon", async () => {
    const { client } = await signIn("member1VizBytes");

    for (const half of ["MORNING", "AFTERNOON"] as const) {
      const id = await submitLeave(client, {
        p_start_date: "2026-12-10",
        p_end_date: "2026-12-10",
        p_start_half: half,
        p_end_half: half,
      });

      expect(await rowOf(id)).toMatchObject({ start_half: half, end_half: half });
    }
  });

  it("accepts afternoon-to-morning across two days at the constraint too", async () => {
    // Same shape as the first case, but reached with the function out of the
    // way — the constraint has its own copy of the single-day rule and has to
    // agree about what is legal, not only about what is not.
    const { error } = await insertRaw({
      request_type: "LEAVE",
      start_date: "2026-12-03",
      end_date: "2026-12-04",
      start_half: "AFTERNOON",
      end_half: "MORNING",
      leave_type_id: leaveTypeId,
    });

    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The single-day rule, enforced twice
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — afternoon to morning on ONE day", () => {
  it("is refused by the function, in a sentence somebody can act on", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "A span that runs backwards inside the day.",
      p_start_date: "2026-12-03",
      p_end_date: "2026-12-03",
      p_start_half: "AFTERNOON",
      p_end_half: "MORNING",
      p_leave_type_id: leaveTypeId,
    } as never);

    // Asserting the SENTENCE, not merely that it failed. The constraint would
    // also refuse this, and the whole reason the function repeats the rule is
    // that a constraint name is not something a person can act on.
    expect(error?.message ?? "").toMatch(/afternoon and end in the morning/i);
  });

  it("is refused by the CHECK constraint, with the function bypassed", async () => {
    const { id, error } = await insertRaw({
      request_type: "LEAVE",
      start_date: "2026-12-03",
      end_date: "2026-12-03",
      start_half: "AFTERNOON",
      end_half: "MORNING",
      leave_type_id: leaveTypeId,
    });

    expect(id).toBeNull();
    // The front end will be bypassed — this is the copy of the rule that a
    // direct API call cannot get round.
    expect(error?.message ?? "").toContain("vizserve_pms_internal_requests_shape");
  });

  it("still allows morning-to-afternoon on that same one day", async () => {
    // The rule is an ordering rule, not a ban on single-day leave. MORNING is
    // declared before AFTERNOON in the enum precisely so `start_half <=
    // end_half` compares them directly; reversing that declaration would invert
    // this case and the one above without changing a line of SQL.
    const { error } = await insertRaw({
      request_type: "LEAVE",
      start_date: "2026-12-03",
      end_date: "2026-12-03",
      start_half: "MORNING",
      end_half: "AFTERNOON",
      leave_type_id: leaveTypeId,
    });

    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Halves belong to LEAVE and to nothing else
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — every other request type", () => {
  it("ignores halves the client had no business sending, rather than refusing", async () => {
    /*
     * The function coerces to null instead of raising, and the migration says
     * why: refusing a reimbursement because the client sent a field it should
     * not have is a worse error message than ignoring it. The constraint would
     * otherwise reject the row outright, so this coercion is load-bearing.
     */
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "REIMBURSEMENT",
      p_reason: "Taxi to the client site.",
      p_amount: 450.5,
      p_start_half: "AFTERNOON",
      p_end_half: "MORNING",
    } as never);

    expect(error).toBeNull();

    const id = (data as unknown as { id: string }).id;
    createdRequests.push(id);

    const row = await rowOf(id);
    expect(row.start_half).toBeNull();
    expect(row.end_half).toBeNull();
  });

  it("refuses a half on a non-leave row at the constraint", async () => {
    // The coercion above is the function being kind. This is the rule.
    const { id, error } = await insertRaw({
      request_type: "REIMBURSEMENT",
      amount: 450.5,
      start_half: "MORNING",
    });

    expect(id).toBeNull();
    expect(error?.message ?? "").toContain("vizserve_pms_internal_requests_shape");
  });

  it("refuses a half on an overtime row too", async () => {
    const { id, error } = await insertRaw({
      request_type: "OVERTIME",
      work_date: "2026-12-03",
      overtime_minutes: 120,
      end_half: "AFTERNOON",
    });

    expect(id).toBeNull();
    expect(error?.message ?? "").toContain("vizserve_pms_internal_requests_shape");
  });
});

// ---------------------------------------------------------------------------
// History — the reason the constraint is NOT VALID
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — leave filed before the halves existed", () => {
  it("accepts a leave row with no halves at all", async () => {
    // Every leave request filed before 19 Aug has null on both columns. The
    // LEAVE branch does not demand them, and this is why: requiring them would
    // make each of those rows unupdatable, so a lead could not even approve one.
    const { id, error } = await insertRaw({
      request_type: "LEAVE",
      start_date: "2026-12-03",
      end_date: "2026-12-05",
      leave_type_id: leaveTypeId,
    });

    expect(error).toBeNull();
    expect(id).not.toBeNull();
  });

  it("still lets a lead decide one", async () => {
    // The real cost of getting the constraint wrong: not a failed insert, but a
    // team leader who cannot approve leave somebody filed last week.
    const { id } = await insertRaw({
      request_type: "LEAVE",
      start_date: "2026-12-03",
      end_date: "2026-12-05",
      leave_type_id: leaveTypeId,
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id!,
      p_decision: "approved",
    });

    expect(error).toBeNull();
    expect((await rowOf(id!)).status).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// What the halves reach, and what they deliberately do not
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-16 — downstream", () => {
  it("carries the halves through approval untouched", async () => {
    /*
     * `vizserve_pms_decide_internal_request` was not amended by this migration.
     * Its `v_req` is the table rowtype, so it picks both columns up for free —
     * which is a claim about a function nobody edited, and therefore exactly the
     * kind of claim that is worth an assertion rather than a comment.
     */
    const { client } = await signIn("member1VizBytes");
    const id = await submitLeave(client, {
      p_start_date: "2026-12-15",
      p_end_date: "2026-12-16",
      p_start_half: "AFTERNOON",
      p_end_half: "MORNING",
    });

    const tl = await signIn("tlVizBytes");
    const { error } = await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(error).toBeNull();

    expect(await rowOf(id)).toMatchObject({
      status: "APPROVED",
      start_half: "AFTERNOON",
      end_half: "MORNING",
    });
  });

  it("does NOT reach the leave calendar, which paints whole days on purpose", async () => {
    /*
     * ASSERTING AN ABSENCE, and deliberately.
     *
     * The migration is explicit that `vizserve_pms_leave_calendar` does not
     * learn the halves: a calendar that rendered them would be making a
     * scheduling claim ("available until midday") that nothing else in this app
     * supports. That is the sort of decision somebody reverses six months later
     * by adding two columns to the function because it looks like an oversight.
     * This test is the note that says it was not.
     */
    const { client } = await signIn("member1VizBytes");
    const id = await submitLeave(client, {
      p_start_date: "2026-12-21",
      p_end_date: "2026-12-21",
      p_start_half: "MORNING",
      p_end_half: "MORNING",
    });

    const tl = await signIn("tlVizBytes");
    await tl.client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    const { data, error } = await client.rpc("vizserve_pms_leave_calendar", {
      p_from: "2026-12-01",
      p_to: "2026-12-31",
    });

    expect(error).toBeNull();

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const mine = rows.filter((row) => row.start_date === "2026-12-21");
    expect(mine.length).toBeGreaterThan(0);

    // A half day is still a day on which somebody is partly away, so the row is
    // there — with four columns and no half among them.
    for (const row of mine) {
      expect(Object.keys(row).sort()).toEqual(["end_date", "full_name", "start_date", "user_id"]);
    }
  });
});
