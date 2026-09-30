import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";

import { adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P14-04 … P14-12 — APPROVAL ROUTING, THE ROLE SWITCHER, AND WHO IS TOLD.
 *
 * Replicates the flows end to end against a real database, as the people who
 * run them:
 *
 *   * overtime: member → the department's Team Leader → the Manager
 *   * the routing's special cases: a Team Leader's own request skips to the
 *     Manager; the Manager's own request approves itself
 *   * who may NOT approve: the Manager at the Team Leader step, a Team Leader
 *     at the Manager step, the CEO anywhere
 *   * timesheets: the Manager only
 *   * one person holding Team Leader AND Manager: approves the first step as
 *     Team Leader, is told to switch, switches, approves the last
 *   * the switcher refuses a role you do not hold
 *   * the pending-work count behind the top-bar notice
 *   * notification rules: approvers are told, the CEO hears about the end,
 *     and a person an Admin adds to a stage is told too
 *
 * ⚠️ WRITES. Runs only against the scratch project named by SUPABASE_TEST_*
 * (helpers.ts refuses the app's own project) seeded with `npm run seed`, and
 * removes everything it creates. Skips — and says why — everywhere else.
 */

if (!dbTestsEnabled) console.warn(`\n  p14-approval-routing.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_notification_events").select("key").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  p14-approval-routing.test.ts — SKIPPED. Apply the P14-04 … P14-12 migrations to the test project first.\n",
  );
}

const run = dbTestsEnabled && migrationApplied;

// ---------------------------------------------------------------------------
// Fixtures and cleanup
// ---------------------------------------------------------------------------

const createdRequests: string[] = [];
const createdWeeks: string[] = [];
const createdRules: string[] = [];
/** Held roles this file granted, and the active role to put back. */
const grantedRoles: { userId: string; role: "manager" }[] = [];
const restoreActive: { userId: string; role: "team_leader" }[] = [];

afterAll(async () => {
  if (!run) return;
  const admin = adminClient();

  const entities = [...createdRequests, ...createdWeeks];
  if (entities.length > 0) {
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", entities);
    await admin.from("vizserve_pms_approvals").delete().in("entity_id", entities);
  }
  if (createdRequests.length > 0) {
    await admin.from("vizserve_pms_internal_requests").delete().in("id", createdRequests);
  }
  if (createdWeeks.length > 0) {
    await admin.from("vizserve_pms_timesheet_weeks").delete().in("id", createdWeeks);
  }
  if (createdRules.length > 0) {
    await admin.from("vizserve_pms_notification_rules").delete().in("id", createdRules);
  }
  for (const { userId, role } of restoreActive) {
    await admin.from("vizserve_pms_users").update({ role }).eq("id", userId);
  }
  for (const { userId, role } of grantedRoles) {
    await admin.from("vizserve_pms_user_roles").delete().eq("user_id", userId).eq("role", role);
  }
});

/** Yesterday, Manila — overtime cannot be filed for a future day. */
const WORK_DATE = addDays(todayInAppZone(), -1)!;

async function fileOvertime(account: Parameters<typeof signIn>[0]): Promise<string> {
  const { client } = await signIn(account);
  const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
    p_request_type: "OVERTIME",
    p_reason: "P14 routing test.",
    p_work_date: WORK_DATE,
    p_overtime_minutes: 60,
  });
  expect(error).toBeNull();
  const id = (data as { id: string }).id;
  createdRequests.push(id);
  return id;
}

async function requestState(id: string) {
  const { data } = await adminClient()
    .from("vizserve_pms_internal_requests")
    .select("status, approval_stage")
    .eq("id", id)
    .single();
  return data!;
}

async function decide(account: Parameters<typeof signIn>[0], id: string, decision: "approved" | "rejected") {
  const { client } = await signIn(account);
  return client.rpc("vizserve_pms_decide_internal_request", {
    p_id: id,
    p_decision: decision,
    p_reason: decision === "rejected" ? "Not needed." : null,
  });
}

async function notified(entityId: string): Promise<{ user_id: string; in_app: boolean; send_email: boolean }[]> {
  const { data } = await adminClient()
    .from("vizserve_pms_notifications")
    .select("user_id, in_app, send_email")
    .eq("entity_id", entityId);
  return data ?? [];
}

// ---------------------------------------------------------------------------

describe.skipIf(!run)("P14 approval routing", () => {
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    for (const account of [
      "member1VizBytes",
      "member2VizBytes",
      "tlVizBytes",
      "tlVizAssists",
      "member1VizAssists",
      "manager",
      "managerAll",
      "admin",
    ] as const) {
      ids[account] = (await signIn(account)).userId;
    }
    ids = { ...ids };
  });

  // ------------------------------------------------------------------ happy path
  describe("overtime: member → Team Leader → Manager", () => {
    let requestId = "";

    it("starts at the Team Leader step and tells that Team Leader", async () => {
      requestId = await fileOvertime("member1VizBytes");

      expect(await requestState(requestId)).toMatchObject({ status: "PENDING_REVIEW", approval_stage: 2 });
      const told = (await notified(requestId)).map((row) => row.user_id);
      expect(told).toContain(ids.tlVizBytes);
      expect(told).not.toContain(ids.manager);
    });

    it("refuses the Manager at the Team Leader step", async () => {
      const { error } = await decide("manager", requestId, "approved");
      expect(error?.message).toMatch(/team leader/i);
    });

    it("moves to the Manager step when the Team Leader approves, and tells the Managers", async () => {
      const { error } = await decide("tlVizBytes", requestId, "approved");
      expect(error).toBeNull();

      expect(await requestState(requestId)).toMatchObject({ status: "PENDING_REVIEW", approval_stage: 3 });
      const told = (await notified(requestId)).map((row) => row.user_id);
      expect(told).toEqual(expect.arrayContaining([ids.manager, ids.managerAll]));
    });

    it("refuses the Team Leader and the CEO at the Manager step", async () => {
      expect((await decide("tlVizBytes", requestId, "approved")).error).not.toBeNull();
      expect((await decide("admin", requestId, "approved")).error).not.toBeNull();
    });

    it("finishes when the Manager approves; the requester and the CEO are told", async () => {
      const { error } = await decide("manager", requestId, "approved");
      expect(error).toBeNull();
      expect((await requestState(requestId)).status).toBe("APPROVED");

      const rows = await notified(requestId);
      expect(rows.map((row) => row.user_id)).toContain(ids.member1VizBytes);

      // P14-11: the CEO hears about the end in the app, not by email.
      const ceo = rows.find((row) => row.user_id === ids.admin);
      expect(ceo).toMatchObject({ in_app: true, send_email: false });
    });
  });

  // --------------------------------------------------------------- special cases
  it("sends a Team Leader's own request straight to the Manager", async () => {
    const requestId = await fileOvertime("tlVizBytes");
    expect(await requestState(requestId)).toMatchObject({ status: "PENDING_REVIEW", approval_stage: 3 });
  });

  it("approves the Manager's own request as soon as it is filed", async () => {
    const requestId = await fileOvertime("manager");
    expect((await requestState(requestId)).status).toBe("APPROVED");
  });

  it("lets a rejection at the Team Leader step end the request", async () => {
    const requestId = await fileOvertime("member2VizBytes");
    const { error } = await decide("tlVizBytes", requestId, "rejected");
    expect(error).toBeNull();
    expect((await requestState(requestId)).status).toBe("REJECTED");
  });

  // ------------------------------------------------------------------ timesheets
  describe("timesheets go to the Manager", () => {
    let weekId = "";

    beforeAll(async () => {
      // A submitted week, planted directly: this suite is about who decides it,
      // not about logging the hours (timesheet-weeks.test.ts covers that).
      // Last week's Monday.
      const monday = startOfWeek(addDays(todayInAppZone(), -7)!)!;
      const { data: member } = await adminClient()
        .from("vizserve_pms_users")
        .select("primary_department_id")
        .eq("id", ids.member1VizBytes)
        .single();
      const { data } = await adminClient()
        .from("vizserve_pms_timesheet_weeks")
        // The generated type says `Insert: never` because the app only ever
        // submits through vizserve_pms_submit_timesheet_week. A fixture may
        // plant one directly with the service role.
        .insert({
          user_id: ids.member1VizBytes,
          week_start: monday,
          department_id: member!.primary_department_id!,
          status: "SUBMITTED",
          submitted_minutes: 2400,
        } as never)
        .select("id")
        .single();
      weekId = data!.id;
      createdWeeks.push(weekId);
    });

    it("refuses the Team Leader", async () => {
      const { client } = await signIn("tlVizBytes");
      const { error } = await client.rpc("vizserve_pms_decide_timesheet_week", {
        p_id: weekId,
        p_decision: "approved",
        p_reason: null,
      });
      expect(error?.message).toMatch(/manager/i);
    });

    it("lets the Manager approve", async () => {
      const { client } = await signIn("manager");
      const { error } = await client.rpc("vizserve_pms_decide_timesheet_week", {
        p_id: weekId,
        p_decision: "approved",
        p_reason: null,
      });
      expect(error).toBeNull();
    });
  });

  // ------------------------------------------------ one person, two roles, switch
  describe("a Team Leader who is also a Manager", () => {
    let requestId = "";

    beforeAll(async () => {
      // TL VizAssists also holds Manager for this block, acting as Team Leader.
      await adminClient().from("vizserve_pms_user_roles").insert({ user_id: ids.tlVizAssists, role: "manager" });
      grantedRoles.push({ userId: ids.tlVizAssists, role: "manager" });
      restoreActive.push({ userId: ids.tlVizAssists, role: "team_leader" });
      requestId = await fileOvertime("member1VizAssists");
    });

    it("approves the Team Leader step while acting as Team Leader", async () => {
      expect((await requestState(requestId)).approval_stage).toBe(2);
      const { error } = await decide("tlVizAssists", requestId, "approved");
      expect(error).toBeNull();
      expect((await requestState(requestId)).approval_stage).toBe(3);
    });

    it("counts the waiting Manager step for the top-bar notice", async () => {
      const { client } = await signIn("tlVizAssists");
      const { data, error } = await client.rpc("vizserve_pms_pending_by_role");
      expect(error).toBeNull();
      const manager = (data ?? []).find((row) => row.role === "manager");
      expect(manager?.pending ?? 0).toBeGreaterThanOrEqual(1);
    });

    it("is told to switch roles at the Manager step", async () => {
      const { error } = await decide("tlVizAssists", requestId, "approved");
      expect(error?.message).toMatch(/switch to your manager role/i);
    });

    it("approves the Manager step after switching", async () => {
      const { client } = await signIn("tlVizAssists");
      const switched = await client.rpc("vizserve_pms_switch_role", { p_role: "manager" });
      expect(switched.error).toBeNull();

      const { error } = await decide("tlVizAssists", requestId, "approved");
      expect(error).toBeNull();
      expect((await requestState(requestId)).status).toBe("APPROVED");
    });
  });

  it("refuses a switch to a role you do not hold", async () => {
    const { client } = await signIn("member1VizBytes");
    const { error } = await client.rpc("vizserve_pms_switch_role", { p_role: "manager" });
    expect(error?.message).toMatch(/do not hold/i);
  });

  // ------------------------------------------------------------ notification rules
  it("tells a person an Admin added to a stage", async () => {
    const { data: rule } = await adminClient()
      .from("vizserve_pms_notification_rules")
      .insert({ event_key: "internal.approved", audience_kind: "user", user_id: ids.member2VizBytes, in_app: true, email: false })
      .select("id")
      .single();
    createdRules.push(rule!.id);

    const requestId = await fileOvertime("tlVizBytes"); // straight to the Manager step
    expect((await decide("manager", requestId, "approved")).error).toBeNull();

    const added = (await notified(requestId)).find((row) => row.user_id === ids.member2VizBytes);
    expect(added).toMatchObject({ in_app: true, send_email: false });
  });

  it("does not tell anybody a switched-off recipient", async () => {
    const admin = adminClient();
    const { data: rule } = await admin
      .from("vizserve_pms_notification_rules")
      .select("id, in_app, email")
      .eq("event_key", "internal.team_leader_step")
      .eq("audience", "approvers")
      .single();

    await admin.from("vizserve_pms_notification_rules").update({ in_app: false, email: false }).eq("id", rule!.id);
    try {
      const requestId = await fileOvertime("member2VizBytes");
      const told = (await notified(requestId)).map((row) => row.user_id);
      expect(told).not.toContain(ids.tlVizBytes);
    } finally {
      await admin
        .from("vizserve_pms_notification_rules")
        .update({ in_app: rule!.in_app, email: rule!.email })
        .eq("id", rule!.id);
    }
  });
});
