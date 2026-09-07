import { afterAll, describe, expect, it } from "vitest";

import { adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P11-01 — THE APPROVAL HISTORY IS READABLE BY EVERYONE WHO CAN READ THE
 * REQUEST.
 *
 * ⚠️ NEVER RUN. Same reason as `relievers.test.ts`: every case here submits a
 * request and approves it, and `SUPABASE_TEST_*` is unset on the build machine
 * so the whole db suite skips. Written now because the rule it pins lives in one
 * migration and one policy and nowhere executable.
 *
 * WHAT WENT WRONG, so a future reader does not undo it. `vizserve_pms_approvals`
 * has recorded every internal decision and its reason since Phase 5, and its
 * P2-00 SELECT policy was `approver_id = auth.uid() or
 * manages_department(department_id)`. That `department_id` is the REQUESTER'S
 * department, so a manager who leads no department — which is most of them, and
 * is exactly who stage 3 asks — matched neither clause and got zero rows. The
 * screen showed them "Team leader · Done" and nothing else: a final signature
 * requested on a decision they were not permitted to see.
 *
 * `test.manager@example.com` is the account that proves it. It manages
 * VizAssists and VizBooks and NOT VizBytes, so against a VizBytes requester it
 * is a stage-3 approver with no departmental claim on the row — the exact shape
 * the old policy refused.
 */

function announce(message: string) {
  // `process.stderr.write`, not `console.warn` — vitest 4 swallows module-level
  // console output, so a suite using console.warn skips SILENTLY.
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`timeline.test.ts — ${skipReason}`);

/**
 * Probed at MODULE LOAD, because `it.skipIf(...)` is evaluated during
 * collection, before any hook runs.
 *
 * ⚠️ THE PROBE IS THE FUNCTION, NOT THE POLICY. A policy cannot be asked about
 * over PostgREST, and querying the table would succeed against a database
 * WITHOUT this migration — the old policy returns zero rows rather than an
 * error, which is precisely the failure being fixed. The `p11_01` function is
 * the only artefact whose absence is loud.
 */
const migrationApplied = dbTestsEnabled
  ? !(
      await adminClient().rpc("vizserve_pms_decided_on_readable_internal_request", {
        p_user_id: "00000000-0000-4000-8000-000000000000",
      })
    ).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "timeline.test.ts — SKIPPED. 20260907100000_p11_01_timeline_readable.sql has not been applied.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const created: string[] = [];

afterAll(async () => {
  if (!run) return;
  if (created.length > 0) {
    /*
     * ⚠️ THE APPROVAL ROWS DO NOT CASCADE. `entity_id` is a plain uuid with no
     * foreign key, deliberately, so Phase 5 could add `internal_request` without
     * touching the P2-00 table. Deleting only the request is exactly what left
     * 12,378 orphaned approvals in production between 18 Aug and 5 Sep — see
     * `scripts/cleanup-test-residue.sql`. This suite cleans up after itself.
     */
    await adminClient()
      .from("vizserve_pms_approvals")
      .delete()
      .eq("entity_type", "internal_request")
      .in("entity_id", created);
    await adminClient().from("vizserve_pms_internal_requests").delete().in("id", created);
  }
});

async function leaveTypeId(code: string): Promise<string> {
  const { data } = await adminClient()
    .from("vizserve_pms_leave_types")
    .select("id")
    .eq("code", code)
    .single();
  return data!.id;
}

/**
 * A VizBytes leave request sitting at stage 3, with one real stage-2 signature
 * behind it.
 *
 * SICK rather than VACATION on purpose: it needs no reliever, so it opens at
 * stage 2 and a single decision moves it to 3. The reliever stage is covered in
 * `relievers.test.ts` and is not what this file is about.
 */
async function requestAwaitingAManager(): Promise<{ id: string; approverId: string }> {
  const { client: requester } = await signIn("member1VizBytes");
  const { data, error } = await requester.rpc("vizserve_pms_submit_internal_request", {
    p_request_type: "LEAVE",
    p_reason: "Flu.",
    p_start_date: "2026-12-14",
    p_end_date: "2026-12-16",
    p_leave_type_id: await leaveTypeId("SICK"),
  });
  expect(error).toBeNull();
  const id = (data as unknown as { id: string }).id;
  created.push(id);

  const { client: lead, userId: approverId } = await signIn("tlVizBytes");
  const decided = await lead.rpc("vizserve_pms_decide_internal_request", {
    p_id: id,
    p_decision: "approved",
    p_reason: "Cover is arranged for the whole span.",
  });
  expect(decided.error).toBeNull();

  return { id, approverId };
}

describe.skipIf(!run)("the approval timeline", () => {
  it("lets the stage-3 manager read the decision they are being asked to countersign", async () => {
    const { id } = await requestAwaitingAManager();

    // Manages VizAssists and VizBooks. NOT VizBytes. Under the P2-00 policy
    // alone this returns [].
    const { client: manager } = await signIn("manager");
    const { data, error } = await manager
      .from("vizserve_pms_approvals")
      .select("decision, reason, created_at, approver_id")
      .eq("entity_type", "internal_request")
      .eq("entity_id", id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].decision).toBe("approved");
    // The reason is the half that matters. A countersignature on an unexplained
    // decision is a rubber stamp.
    expect(data![0].reason).toMatch(/cover is arranged/i);
  });

  it("resolves the previous approver's name, not just their id", async () => {
    const { id, approverId } = await requestAwaitingAManager();
    expect(id).toBeTruthy();

    // P9-08 opened `vizserve_pms_users` to a stage-3 manager for the REQUESTER
    // and the named RELIEVERS only — prior approvers were not in its list,
    // because at the time nothing displayed them. Without this the rail renders
    // "· 6 Dec ·" with a hole where the person should be, which reads as a
    // rendering fault rather than as a missing permission.
    const { client: manager } = await signIn("manager");
    const { data } = await manager
      .from("vizserve_pms_users")
      .select("id, full_name")
      .eq("id", approverId)
      .maybeSingle();

    expect(data?.full_name).toBeTruthy();
  });

  it("shows the requester the decisions on their own request", async () => {
    const { id } = await requestAwaitingAManager();

    // The audience rule is "if you can read the request you can read its
    // history", and the requester is the person who most needs the reason: a
    // refusal with no visible cause gets refiled unchanged and refused again.
    const { client: requester } = await signIn("member1VizBytes");
    const { data } = await requester
      .from("vizserve_pms_approvals")
      .select("decision, reason")
      .eq("entity_type", "internal_request")
      .eq("entity_id", id);

    expect(data).toHaveLength(1);
    expect(data![0].reason).toMatch(/cover is arranged/i);
  });

  it("does not open the row to somebody with no claim on the request", async () => {
    const { id } = await requestAwaitingAManager();

    // A member of another department entirely. The widening defers to
    // `may_read_internal_request`, so anyone that function refuses is still
    // refused here — a policy that leaked to every authenticated user would pass
    // all three cases above and be catastrophically wrong.
    const { client: outsider } = await signIn("member1VizAssists");
    const { data, error } = await outsider
      .from("vizserve_pms_approvals")
      .select("decision")
      .eq("entity_type", "internal_request")
      .eq("entity_id", id);

    // ⚠️ ZERO ROWS, NOT AN ERROR. A failing policy returns nothing; `permission
    // denied` would mean a missing GRANT, which is a different bug with a
    // different fix — see the grants incident in CLAUDE.md.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  /*
   * ⚠️ THE OTHER TWO ENTITY TYPES ARE COVERED ELSEWHERE, DELIBERATELY.
   *
   * The new clause is guarded on `entity_type = 'internal_request'`, and what
   * proves the guard works is that client requests and timesheet weeks behave
   * exactly as before. `tests/db/approval-engine.test.ts:618` already asserts
   * that an out-of-scope team leader gets [] for a client request, and it runs
   * in this same suite. A second copy here would be one more assertion to keep
   * in step — which is the habit this codebase has been paying for all week.
   */
});
