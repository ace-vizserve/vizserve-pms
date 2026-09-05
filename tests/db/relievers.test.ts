import { afterAll, describe, expect, it } from "vitest";

import { adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P9 — RELIEVERS, THE THREE-STAGE CHAIN, AND WITHDRAWAL.
 *
 * ⚠️ THIS FILE HAS NEVER BEEN RUN. The Supabase project in `.env` is the LIVE
 * one, and these cases submit requests, name relievers and hand tasks over —
 * every one of them writes. It needs a scratch project or `supabase db start`.
 * It is written now so the rules are stated somewhere executable rather than
 * only in four migrations.
 *
 * WHAT IS HERE AND NOWHERE ELSE. `tests/unit/relievers.test.ts` pins the shape
 * of the payload; these are the three rules that live only in Postgres because
 * they are questions about other tables:
 *
 *   * does this leave type require a reliever at all
 *   * is each named person an active member of the requester's own department
 *   * is each task one the requester is actually on
 *
 * Plus the two that are about SEQUENCE, which no schema can express: a stage
 * that will not advance until every reliever has answered, and a withdrawal
 * that stops being legal the moment somebody does.
 */

function announce(message: string) {
  // `process.stderr.write`, not `console.warn` — vitest 4 swallows module-level
  // console output entirely, so every suite using console.warn has been
  // skipping SILENTLY. A suite that skips silently reports green while proving
  // nothing, which is worse than red.
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`relievers.test.ts — ${skipReason}`);

/**
 * Probed at MODULE LOAD, because `it.skipIf(...)` is evaluated during
 * collection, before any hook runs — a flag set in `beforeAll` is still false
 * at every skip decision. That has gone wrong here once already.
 *
 * The probe is the RELIEVERS TABLE, not the enum value or the leave-type
 * column. P9-01 is the file that creates it, and filtering on a status value
 * this database has never heard of does NOT error — it returns zero rows and
 * reports success, so the obvious "has this landed" check would pass against a
 * database missing everything.
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_internal_request_relievers").select("id").limit(1))
      .error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "relievers.test.ts — SKIPPED. The P9 migrations" +
      " (20260905090000_p9_01_relievers.sql, 20260905091000_p9_02_withdrawn_status.sql," +
      " 20260905092000_p9_03_submit_and_withdraw.sql, 20260905093000_p9_04_decide_chain.sql)" +
      " have not been applied. Apply them in filename order — 02 MUST commit before 03," +
      " because Postgres refuses a new enum value in the transaction that adds it.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const created: string[] = [];
const createdTasks: string[] = [];

afterAll(async () => {
  if (!run) return;
  const admin = adminClient();
  // Relievers and their task links cascade from the request.
  if (created.length > 0) {
    await admin.from("vizserve_pms_internal_requests").delete().in("id", created);
  }
  if (createdTasks.length > 0) {
    await admin.from("vizserve_pms_tasks").delete().in("id", createdTasks);
  }
});

/** The VizBytes leave types, by code. Vacation is the seeded reliever type. */
async function leaveTypeId(code: string): Promise<string> {
  const { data } = await adminClient()
    .from("vizserve_pms_leave_types")
    .select("id")
    .eq("code", code)
    .single();
  return data!.id;
}

/**
 * A task owned by `userId`, so there is something real to hand over.
 *
 * ⚠️ THROUGH THE FUNCTION, not a direct insert. `vizserve_pms_tasks` has no
 * INSERT policy and `lib/database.types.ts` says `Insert: never` — tasks are
 * born from `vizserve_pms_create_task`, which is also where the "assignee must
 * be in this department" rule lives. A test that wrote the row directly would
 * be building a task the app cannot build.
 *
 * Filed as the department's lead, since P7-14 lets a member create only for
 * their own department and two of these cases need one filed for somebody else.
 */
async function makeTask(userId: string, departmentId: string, title: string): Promise<string> {
  const { client } = await signIn("tlVizBytes");
  const { data, error } = await client.rpc("vizserve_pms_create_task", {
    p_department_id: departmentId,
    p_title: title,
    p_assignee_id: userId,
  });
  expect(error).toBeNull();
  const id = (data as unknown as { task_id: string }).task_id;
  createdTasks.push(id);
  return id;
}

async function departmentOf(userId: string): Promise<string> {
  const { data } = await adminClient()
    .from("vizserve_pms_users")
    .select("primary_department_id")
    .eq("id", userId)
    .single();
  return data!.primary_department_id!;
}

const SPAN = { p_start_date: "2026-12-07", p_end_date: "2026-12-11" };

describe.skipIf(!run)("submitting a hand-over", () => {
  it("refuses vacation with no reliever, and says so in a sentence", async () => {
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
    });

    // A constraint name here would be useless to the person filling the form.
    expect(error?.message).toMatch(/needs a reliever/i);
  });

  it("lets sick leave through untouched — the flag is per type", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Flu.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("SICK"),
    });

    expect(error).toBeNull();
    created.push((data as unknown as { id: string }).id);

    // ...but it still opens at stage 2, not 0. EVERY leave takes two signatures
    // now; only the reliever stage is conditional.
    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("approval_stage")
      .eq("id", (data as unknown as { id: string }).id)
      .single();
    expect(row!.approval_stage).toBe(2);
  });

  it("leaves overtime and reimbursement unchained at stage 0", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "REIMBURSEMENT",
      p_reason: "Courier for the client's samples.",
      p_amount: 480,
    });
    created.push((data as unknown as { id: string }).id);

    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("approval_stage")
      .eq("id", (data as unknown as { id: string }).id)
      .single();
    // The whole non-leave world keeps today's single decision by any lead.
    expect(row!.approval_stage).toBe(0);
  });

  it("refuses somebody naming themselves", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    const task = await makeTask(userId, await departmentOf(userId), "P9 self-reliever probe");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: userId, task_ids: [task] }],
      p_turnover_confirmed: true,
    });

    expect(error?.message).toMatch(/your own reliever/i);
  });

  it("refuses a reliever from another department", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    const { userId: outsider } = await signIn("member1VizAssists");
    const task = await makeTask(userId, await departmentOf(userId), "P9 cross-dept probe");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: outsider, task_ids: [task] }],
      p_turnover_confirmed: true,
    });

    expect(error?.message).toMatch(/your own department/i);
  });

  it("refuses a task the requester is not on", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    const { userId: other } = await signIn("member2VizBytes");
    // Somebody else's task, in the same department — so only `is_on_task`
    // separates it from a legitimate hand-over.
    const theirs = await makeTask(other, await departmentOf(userId), "P9 not-yours probe");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: other, task_ids: [theirs] }],
      p_turnover_confirmed: true,
    });

    expect(error?.message).toMatch(/not on one of the tasks/i);
  });

  it("refuses an unticked turn-over confirmation", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    const { userId: other } = await signIn("member2VizBytes");
    const task = await makeTask(userId, await departmentOf(userId), "P9 unticked probe");

    const { error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: other, task_ids: [task] }],
      p_turnover_confirmed: false,
    });

    expect(error?.message).toMatch(/confirm the turn-over/i);
  });
});

describe.skipIf(!run)("the chain, in order", () => {
  /** A vacation request with two relievers, ready to be walked through. */
  async function fileVacation() {
    const { client, userId } = await signIn("member1VizBytes");
    const department = await departmentOf(userId);
    const { userId: r1 } = await signIn("member2VizBytes");
    const taskA = await makeTask(userId, department, "P9 chain task A");
    const taskB = await makeTask(userId, department, "P9 chain task B");

    const { data, error } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: r1, task_ids: [taskA, taskB] }],
      p_turnover_confirmed: true,
    });

    expect(error).toBeNull();
    const id = (data as unknown as { id: string }).id;
    created.push(id);
    return { id, requester: userId, reliever: r1, taskA, taskB };
  }

  async function stageOf(id: string): Promise<number> {
    const { data } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("approval_stage")
      .eq("id", id)
      .single();
    return data!.approval_stage;
  }

  it("opens at stage 1 and refuses the team leader until the relievers answer", async () => {
    const { id } = await fileVacation();
    expect(await stageOf(id)).toBe(1);

    const { client: tl } = await signIn("tlVizBytes");
    const { error } = await tl.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    // The lead can SEE it — they lead the department — and it is not theirs.
    expect(error?.message).toMatch(/waiting on the relievers/i);
    expect(await stageOf(id)).toBe(1);
  });

  it("walks reliever → team leader → manager, and only then is it approved", async () => {
    const { id, reliever } = await fileVacation();

    const { client: cover } = await signIn("member2VizBytes");
    expect(reliever).toBeTruthy();
    const accepted = await cover.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(accepted.error).toBeNull();
    expect(await stageOf(id)).toBe(2);

    const { client: tl } = await signIn("tlVizBytes");
    const led = await tl.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(led.error).toBeNull();
    expect(await stageOf(id)).toBe(3);

    // ⚠️ STILL PENDING. A lead approving leave no longer finishes it, and every
    // screen that read `status` alone as "decided" was right until P9-04.
    const { data: midway } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("status")
      .eq("id", id)
      .single();
    expect(midway!.status).toBe("PENDING_REVIEW");

    // A manager who leads no department at all. This is the only approval
    // authority in the app that is not scoped to a managed department.
    const { client: manager } = await signIn("manager");
    const final = await manager.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    expect(final.error).toBeNull();

    const { data: done } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("status")
      .eq("id", id)
      .single();
    expect(done!.status).toBe("APPROVED");
  });

  it("is terminal wherever it is rejected, and the reason is required", async () => {
    const { id } = await fileVacation();
    const { client: cover } = await signIn("member2VizBytes");

    const bare = await cover.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "rejected",
    });
    // A reliever's refusal does not pass through the engine, so this rule is
    // enforced in the decide function and by the table constraint.
    expect(bare.error?.message).toMatch(/say why/i);

    const declined = await cover.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "rejected",
      p_reason: "I am already covering two people that fortnight.",
    });
    expect(declined.error).toBeNull();

    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("status")
      .eq("id", id)
      .single();
    // Not returned to the requester for editing — internal requests have no
    // RETURNED path and this does not invent one. They refile.
    expect(row!.status).toBe("REJECTED");
  });
});

describe.skipIf(!run)("coverage", () => {
  it("gives the reliever the task only while the leave is running", async () => {
    // ⚠️ REQUIRES A LEAVE SPAN CONTAINING TODAY, so this case files one rather
    // than reusing SPAN. `vizserve_pms_active_task_coverage` is a question
    // about today in Manila, and a December span proves nothing in September.
    const { client, userId } = await signIn("member1VizBytes");
    const department = await departmentOf(userId);
    const { userId: r1 } = await signIn("member2VizBytes");
    const task = await makeTask(userId, department, "P9 coverage probe");

    const today = new Date().toISOString().slice(0, 10);
    const { data } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      p_start_date: today,
      p_end_date: today,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: r1, task_ids: [task] }],
      p_turnover_confirmed: true,
    });
    const id = (data as unknown as { id: string }).id;
    created.push(id);

    const { client: cover } = await signIn("member2VizBytes");

    // Before approval: nothing. Coverage keys off APPROVED leave, so a pending
    // hand-over grants no access at all.
    const before = await cover.from("vizserve_pms_tasks").select("id").eq("id", task).maybeSingle();
    expect(before.data).toBeNull();

    await (await signIn("member2VizBytes")).client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    await (await signIn("tlVizBytes")).client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });
    await (await signIn("manager")).client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    // After: the reliever reaches a task they were never assigned, through the
    // one clause added to `vizserve_pms_is_on_task`.
    const after = await cover.from("vizserve_pms_tasks").select("id").eq("id", task).maybeSingle();
    expect(after.data?.id).toBe(task);

    // The original assignee is untouched. Nothing has to be un-done when the
    // leave ends — the view simply stops matching tomorrow.
    const { data: still } = await adminClient()
      .from("vizserve_pms_tasks")
      .select("assignee_id")
      .eq("id", task)
      .single();
    expect(still!.assignee_id).toBe(userId);
  });
});

describe.skipIf(!run)("withdrawal", () => {
  it("lets the author take back a request nobody has answered", async () => {
    const { client } = await signIn("member1VizBytes");
    const { data } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Flu.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("SICK"),
    });
    const id = (data as unknown as { id: string }).id;
    created.push(id);

    const { error } = await client.rpc("vizserve_pms_withdraw_internal_request", { p_id: id });
    expect(error).toBeNull();

    const { data: row } = await adminClient()
      .from("vizserve_pms_internal_requests")
      .select("status")
      .eq("id", id)
      .single();
    // NOT REJECTED. That distinction is the entire reason this exists — before
    // it, undoing a mistyped request meant asking a lead to refuse one.
    expect(row!.status).toBe("WITHDRAWN");
  });

  it("refuses once anybody has answered", async () => {
    const { client, userId } = await signIn("member1VizBytes");
    const department = await departmentOf(userId);
    const { userId: r1 } = await signIn("member2VizBytes");
    const task = await makeTask(userId, department, "P9 withdraw-race probe");

    const { data } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Family trip.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("VACATION"),
      p_relievers: [{ reliever_id: r1, task_ids: [task] }],
      p_turnover_confirmed: true,
    });
    const id = (data as unknown as { id: string }).id;
    created.push(id);

    await (await signIn("member2VizBytes")).client.rpc("vizserve_pms_decide_internal_request", {
      p_id: id,
      p_decision: "approved",
    });

    // Still PENDING_REVIEW — one reliever accepted and the chain moved on. The
    // shallower rule "while it is pending" would have allowed this, and pulling
    // a request out from under somebody who has already signed is the surprise
    // the stricter rule exists to prevent.
    const { error } = await client.rpc("vizserve_pms_withdraw_internal_request", { p_id: id });
    expect(error?.message).toMatch(/already answered/i);
  });

  it("refuses a lead trying to withdraw somebody else's request", async () => {
    const { client } = await signIn("member1VizBytes");
    const { data } = await client.rpc("vizserve_pms_submit_internal_request", {
      p_request_type: "LEAVE",
      p_reason: "Flu.",
      ...SPAN,
      p_leave_type_id: await leaveTypeId("SICK"),
    });
    const id = (data as unknown as { id: string }).id;
    created.push(id);

    const { client: tl } = await signIn("tlVizBytes");
    const { error } = await tl.rpc("vizserve_pms_withdraw_internal_request", { p_id: id });

    // A lead who wants it gone has `reject`, which asks them for a reason. That
    // asymmetry is the design: withdrawing owes nobody an explanation precisely
    // because only the author can do it.
    expect(error?.message).toMatch(/only the person who filed/i);
  });
});

describe.skipIf(!run)("the turn-over confirmation, as a database rule", () => {
  /**
   * P9-07 — the layer the app cannot reach.
   *
   * `vizserve_pms_submit_internal_request` already refuses an unticked
   * hand-over with a better sentence, so nothing filing through the app gets
   * here. These write the table DIRECTLY, as the service role, which is the
   * only way to exercise the trigger — and the point of the trigger is exactly
   * that a second write path is possible.
   *
   * ⚠️ THE ERROR ARRIVES AT COMMIT, not at the INSERT. The trigger is
   * `deferrable initially deferred` because the reliever rows are written after
   * the request they belong to; supabase-js sends each call in its own
   * transaction, so a failing insert still surfaces as a rejected request here.
   */
  async function insertRaw(over: Record<string, unknown>) {
    const admin = adminClient();
    const { data: user } = await admin
      .from("vizserve_pms_users")
      .select("id, primary_department_id")
      .eq("email", "ace.guevarra@vizserve.hfse.edu.sg")
      .single();

    return admin
      .from("vizserve_pms_internal_requests")
      // `as never` — `Insert` is deliberately typed shut on this table, which
      // is the TypeScript half of the same rule this trigger enforces in SQL.
      .insert({
        request_type: "LEAVE",
        requester_id: user!.id,
        department_id: user!.primary_department_id,
        reason: "P9-07 trigger probe",
        start_date: "2099-01-04",
        end_date: "2099-01-05",
        leave_type_id: await leaveTypeId("VACATION"),
        approval_stage: 1,
        ...over,
      } as never)
      .select("id")
      .maybeSingle();
  }

  it("refuses a reliever leave filed with no confirmation at all", async () => {
    const { data, error } = await insertRaw({});

    expect(data).toBeNull();
    expect(error?.message).toMatch(/turn-over confirmation/i);
  });

  it("refuses a confirmation with no reliever behind it", async () => {
    // The sentence attests that "each has been assigned a corresponding
    // reliever". A tick over an empty list is a claim about nothing, which is
    // worse than no claim.
    const { data, error } = await insertRaw({ turnover_confirmed_at: new Date().toISOString() });

    expect(data).toBeNull();
    expect(error?.message).toMatch(/no reliever was named/i);
  });

  it("leaves sick leave alone — the rule is per leave type", async () => {
    const { data, error } = await insertRaw({
      leave_type_id: await leaveTypeId("SICK"),
      approval_stage: 2,
    });

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    if (data?.id) created.push(data.id);
  });

  it("still lets a legacy VACATION row be decided", async () => {
    /*
     * ⚠️ THE REGRESSION THIS TRIGGER WOULD HAVE CAUSED IF IT FIRED ON UPDATE.
     *
     * VACATION requests filed before P9-01 carry no confirmation and no
     * relievers, because neither existed. They are still in queues.
     * `vizserve_pms_decide_internal_request` UPDATEs status, reviewed_by and
     * reviewed_at — an UPDATE trigger would make every one of them impossible
     * to approve or reject, citing a checkbox their author was never shown.
     *
     * INSERT-only is what keeps them decidable. This asserts the update path is
     * untouched, using a row the trigger would refuse on insert.
     */
    const admin = adminClient();
    const { data: legacy } = await admin
      .from("vizserve_pms_internal_requests")
      .select("id")
      .eq("request_type", "LEAVE")
      .is("turnover_confirmed_at", null)
      .limit(1)
      .maybeSingle();

    if (!legacy) return; // Nothing pre-P9 left in this database; nothing to prove.

    const { error } = await admin
      .from("vizserve_pms_internal_requests")
      .update({ reviewed_at: new Date().toISOString() })
      .eq("id", legacy.id);

    expect(error).toBeNull();
  });
});
