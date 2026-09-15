import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCOUNTS,
  DEPARTMENTS,
  adminClient,
  dbTestsEnabled,
  isPermissionDenied,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P7-17 — a department can see itself.
 *
 * The migration widens two things and refuses to widen a third, and the third is
 * the part most likely to be lost. Every assertion here is one of:
 *
 *   * a member reads their own colleagues        (the bug P7-14 left behind)
 *   * a member reads their department's work     (the second gap)
 *   * a member reads a colleague's PERSONAL task — they must not
 *   * a member EDITS what they can now see       — they must not
 *
 * The last two are what stop this being a blanket widening, and they are the
 * ones a future "simplify the policies" pass would take out without noticing.
 *
 * Written as row counts through a real signed-in session, never with the service
 * key: the service role bypasses policies, so a suite that used it here would
 * pass while asserting nothing at all.
 */

/** `process.stderr.write`, not `console.warn` — vitest 4 swallows the latter at module level. */
function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`department-visibility.test.ts — ${skipReason}`);

/**
 * Detected at MODULE LOAD, because `it.skipIf(...)` is evaluated during
 * collection and a flag set in `beforeAll` is still false at every skip decision.
 *
 * Probed on the FUNCTION rather than on a policy: policies are not reachable
 * through PostgREST, and `vizserve_pms_my_department()` is the artefact both
 * policies in this migration are built on — no function, no widening. Called
 * with the service key, where `auth.uid()` is null, so it returns null without
 * error; the absence of an error is the signal, not the value.
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().rpc("vizserve_pms_my_department" as never)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "department-visibility.test.ts — SKIPPED." +
      " supabase/migrations/20260819100000_p7_17_department_visibility.sql is not applied to" +
      " this project. Apply it in the dashboard SQL editor, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const created: string[] = [];

/** A department task with a known participant, and a personal one that is nobody else's. */
let departmentTaskId = "";
let personalTaskId = "";

/**
 * A throwaway account, created and destroyed by this file.
 *
 * DELIBERATELY NOT ONE OF THE SEEDED SIXTEEN. The `is_active` clause needs a
 * deactivated colleague to assert against, and flipping a seeded account's flag
 * to get one would leave that account unable to log in if the run died between
 * the flip and the restore — in a project that is shared with the app somebody
 * is browsing. A user that exists only for this file cannot strand anything.
 */
let tempUserId = "";
const tempEmail = `test.p7-17.${Math.random().toString(36).slice(2, 8)}@example.com`;

beforeAll(async () => {
  if (!run) return;

  const admin = adminClient();

  // A VizBytes task whose only participant is the team leader. Neither member is
  // PIC, QA, or on the join table — so the ONLY thing that can make it visible
  // to them is the clause this migration added.
  const tl = await signIn("tlVizBytes");
  const { data: task, error: taskError } = await tl.client.rpc("vizserve_pms_create_task", {
    p_department_id: DEPARTMENTS.VizBytes,
    p_title: `P7-17 department task ${Math.random().toString(36).slice(2, 8)}`,
    p_description: "Nobody but the lead is on this one.",
    p_assignee_id: tl.userId,
    p_qa_assignee_id: null,
    p_due_date: null,
    p_list_id: null,
  });

  if (taskError) throw new Error(`fixture department task: ${taskError.message}`);
  departmentTaskId = (task as { task_id: string }).task_id;
  created.push(departmentTaskId);

  // member1's own private list. `is_personal` is the exception the migration
  // carves out, and this is the row that proves it holds.
  const member1 = await signIn("member1VizBytes");
  const { data: personal, error: personalError } = await member1.client.rpc(
    "vizserve_pms_create_personal_task",
    {
      p_title: `P7-17 personal ${Math.random().toString(36).slice(2, 8)}`,
      p_description: "A private to-do, which is what is_personal means.",
      p_due_date: null,
      p_list_id: null,
    },
  );

  if (personalError) throw new Error(`fixture personal task: ${personalError.message}`);
  personalTaskId = (personal as { task_id: string }).task_id;
  created.push(personalTaskId);

  // The deactivated colleague. Created through the auth admin API so the
  // `on auth.users` trigger writes the profile row, then placed in VizBytes and
  // switched off.
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email: tempEmail,
    password: `P7-17-${Math.random().toString(36).slice(2)}!`,
    email_confirm: true,
    user_metadata: { full_name: "P7-17 Deactivated Colleague" },
  });

  if (authError || !authUser.user) {
    throw new Error(`fixture temp user: ${authError?.message ?? "no user returned"}`);
  }

  tempUserId = authUser.user.id;

  const { error: profileError } = await admin
    .from("vizserve_pms_users")
    .update({ primary_department_id: DEPARTMENTS.VizBytes, is_active: false })
    .eq("id", tempUserId);

  if (profileError) throw new Error(`fixture temp profile: ${profileError.message}`);
});

afterAll(async () => {
  if (!run) return;

  const admin = adminClient();

  if (created.length > 0) {
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", created);
    await admin.from("vizserve_pms_tasks").delete().in("id", created);
  }

  // Deleting the auth row cascades to the profile — `vizserve_pms_users.id`
  // references `auth.users (id) on delete cascade`. Deleting the profile alone
  // would leave an orphaned login behind.
  if (tempUserId) await admin.auth.admin.deleteUser(tempUserId);
});

// ---------------------------------------------------------------------------
// Gap 1 — a member could not see their own colleagues
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-17 — colleagues", () => {
  it("shows a member the other people in their department", async () => {
    /*
     * THE BUG, stated as a count. Before this migration a member read exactly
     * one row — their own — because a member manages nothing. P7-14 had already
     * given them the right to assign work to a colleague, so the picker that
     * right exists for was empty: a real capability, unusable.
     */
    const { client, userId } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_users")
      .select("id, email, primary_department_id");

    expect(error).toBeNull();

    const emails = new Set((data ?? []).map((row) => row.email.toLowerCase()));
    expect(emails.has(ACCOUNTS.member2VizBytes)).toBe(true);
    expect(emails.has(ACCOUNTS.tlVizBytes)).toBe(true);
    // Still themselves too — the pre-existing "read own profile" policy is
    // OR-ed with the new one rather than replaced by it.
    expect((data ?? []).some((row) => row.id === userId)).toBe(true);
  });

  it("does not read the policy from inside itself — no infinite recursion", async () => {
    /*
     * `vizserve_pms_my_department()` reads `vizserve_pms_users` from inside a
     * policy ON `vizserve_pms_users`. Without SECURITY DEFINER that re-enters
     * the policy and Postgres reports a stack depth error on EVERY query against
     * the table — not a subtle degradation, a dead table.
     *
     * A clean select is therefore the whole assertion, and it is worth its own
     * case because the failure mode is catastrophic and the fix is one keyword
     * somebody could drop while tidying.
     */
    const { client } = await signIn("member1VizBytes");
    const { error } = await client.from("vizserve_pms_users").select("id").limit(1);

    expect(error).toBeNull();
    expect(error?.message ?? "").not.toContain("stack depth");
  });

  it("stops at the department boundary", async () => {
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_users")
      .select("id")
      .eq("email", ACCOUNTS.member1VizAssists);

    // Zero rows, which is a working policy. `permission denied` here would be a
    // missing GRANT and a different bug entirely.
    expect(error).toBeNull();
    expect(isPermissionDenied(error)).toBe(false);
    expect(data).toHaveLength(0);
  });

  it("does not leak people who belong to no department", async () => {
    // The admin and the two managers carry a null `primary_department_id`, and
    // the policy demands `primary_department_id is not null` before comparing.
    // Without that clause a null-department member would see every other
    // null-department account, which is every admin in the system.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_users")
      .select("id")
      .in("email", [ACCOUNTS.admin, ACCOUNTS.managerAll]);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("does not show a deactivated colleague", async () => {
    // A leaver whose row stays readable is how a leaver keeps appearing in
    // assignee pickers — which is the specific thing that makes a picker
    // untrustworthy rather than merely wrong.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_users")
      .select("id")
      .eq("id", tempUserId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("shows that same colleague the moment they are reactivated", async () => {
    // The other direction, so the case above is proving the `is_active` clause
    // rather than proving that the fixture user was never visible for some
    // unrelated reason.
    const admin = adminClient();
    await admin.from("vizserve_pms_users").update({ is_active: true }).eq("id", tempUserId);

    try {
      const { client } = await signIn("member1VizBytes");
      const { data, error } = await client
        .from("vizserve_pms_users")
        .select("id")
        .eq("id", tempUserId);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    } finally {
      // Switched back inside a finally: a failed expectation above must not
      // leave an active stray account in the pickers of the app being browsed.
      await admin.from("vizserve_pms_users").update({ is_active: false }).eq("id", tempUserId);
    }
  });

  it("leaves the lead and admin policies exactly as they were", async () => {
    /*
     * The migration is additive and says so, but "additive" is a claim about a
     * DROP that could have taken a policy with it. `managerAll` is the account
     * that proves it: they carry NO department of their own, so the new clause
     * cannot serve them at all and every row they read comes from the
     * pre-existing "users read managed departments" policy.
     */
    const { client } = await signIn("managerAll");

    const { data, error } = await client
      .from("vizserve_pms_users")
      .select("email")
      .in("email", [ACCOUNTS.member1VizBytes, ACCOUNTS.member1VizAssists]);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — a member could not see their department's work
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-17 — the department's work", () => {
  it("shows a member a task they are not on", async () => {
    // Two people in one department, neither on the other's tasks, working in the
    // same room and seeing none of each other's board. That was the state before
    // this line.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id, title")
      .eq("id", departmentTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("does not show it to another department", async () => {
    const { client } = await signIn("member1VizAssists");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", departmentTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("keeps a colleague's PERSONAL task private", async () => {
    /*
     * THE EXPLICIT EXCEPTION, and the one worth defending hardest. `is_personal`
     * means "work I recorded for myself" (P7-01) and its owner closes it with no
     * reviewer. Publishing it to the department turns a private to-do list into
     * a public one, which is a different decision from the one this migration
     * made.
     */
    const { client } = await signIn("member2VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", personalTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("still shows a personal task to its owner and to their lead", async () => {
    // Neither of these is new, and that is the point: the new clause is the only
    // one that excludes a personal task, so both older paths have to keep
    // working or the exception has quietly become a deletion.
    const owner = await signIn("member1VizBytes");
    const { data: mine } = await owner.client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", personalTaskId);
    expect(mine).toHaveLength(1);

    // The lead's view is what makes a department's hours add up on the
    // timesheet — a personal task nobody can see is time nobody can account for.
    const tl = await signIn("tlVizBytes");
    const { data: theirs } = await tl.client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", personalTaskId);
    expect(theirs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What was deliberately NOT widened
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-17 — seeing is not editing", () => {
  it("does not let a member edit a department task they can now read", async () => {
    /*
     * SELECT was widened; UPDATE was not. Widening both together would have made
     * every member an editor of everything in their department, which nobody
     * decided — and it is the exact mistake that looks like consistency.
     *
     * An UPDATE that RLS refuses returns zero rows and NO error, so asserting
     * `error === null` here would pass on a wide-open policy. The assertion has
     * to be that the row did not change.
     */
    const { client } = await signIn("member1VizBytes");

    const { data: before } = await adminClient()
      .from("vizserve_pms_tasks")
      .select("title")
      .eq("id", departmentTaskId)
      .single();

    const { data: updated } = await client
      .from("vizserve_pms_tasks")
      .update({ title: "Renamed by somebody who only had read access" })
      .eq("id", departmentTaskId)
      .select("id");

    expect(updated ?? []).toHaveLength(0);

    const { data: after } = await adminClient()
      .from("vizserve_pms_tasks")
      .select("title")
      .eq("id", departmentTaskId)
      .single();

    expect(after!.title).toBe(before!.title);
  });

  it("does not let a member move a department task through the state machine", async () => {
    // `vizserve_pms_transition_task` guards on PARTICIPATION, not visibility. A
    // member can now watch a colleague's task move; they still cannot move it.
    const { client } = await signIn("member1VizBytes");

    const { error } = await client.rpc("vizserve_pms_transition_task", {
      p_task_id: departmentTaskId,
      p_to_status: "ONGOING",
      p_comment: null,
    });

    expect(error?.message ?? "").toContain("not yours");
  });

  it("leaves timesheet entries owner-and-lead only", async () => {
    /*
     * Hours are a payroll record rather than a board, and the migration says so.
     * Asserted here because this file is where somebody will come looking when
     * they wonder why the department can see the task but not the time on it —
     * and the answer is that `vizserve_pms_task_time_tracked` is SECURITY
     * DEFINER precisely so the total is readable by people who cannot read the
     * entries behind it.
     */
    const tl = await signIn("tlVizBytes");
    const { error: seedError } = await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .insert({
        user_id: tl.userId,
        task_id: departmentTaskId,
        work_date: "2026-12-03",
        minutes: 60,
      } as never);

    // The insert is a fixture, not an assertion — if the timesheet migration is
    // absent there is nothing here to test and the case has no business failing.
    if (seedError) return;

    const { client } = await signIn("member1VizBytes");
    const { data, error } = await client
      .from("vizserve_pms_timesheet_entries")
      .select("id")
      .eq("task_id", departmentTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    await adminClient()
      .from("vizserve_pms_timesheet_entries")
      .delete()
      .eq("task_id", departmentTaskId);
  });
});

// ---------------------------------------------------------------------------
// P12-16 — what the peer clause asks about now
// ---------------------------------------------------------------------------

/**
 * P12-16 — a shared list is shared.
 *
 * The peer clause tested `not is_personal` from P7-17 until 15 Sep 2026, and the
 * four cases below are the whole of what changed. The pivot is the same one
 * P11-08 made for the lead's clause: privacy is `vizserve_pms_lists.owner_id`,
 * never the flag.
 *
 * ⚠️ THE FIXTURES ARE THE ASSERTION HERE. Both tasks are created by
 * `vizserve_pms_create_personal_task`, so both carry `is_personal = true` and
 * differ in ONE thing — the list they are filed in. If a future edit makes them
 * differ in anything else, this file stops testing the clause it is named after.
 */
describe.skipIf(!run)("P12-16 — a shared list is shared", () => {
  /** A VizBytes list nobody owns — the "User Support" shape. */
  let sharedListId = "";
  /** member1's own list — the P11-06 shape. */
  let privateListId = "";
  /** `is_personal`, filed in the shared list. The support ticket. */
  let sharedListTaskId = "";
  /** `is_personal`, filed in member1's own list. The private to-do. */
  let privateListTaskId = "";

  beforeAll(async () => {
    if (!run) return;

    const admin = adminClient();
    const member1 = await signIn("member1VizBytes");

    const { data: shared, error: sharedError } = await admin
      .from("vizserve_pms_lists")
      .insert({
        department_id: DEPARTMENTS.VizBytes,
        name: `P12-16 shared ${Math.random().toString(36).slice(2, 8)}`,
      } as never)
      .select("id")
      .single();

    if (sharedError) throw new Error(`fixture shared list: ${sharedError.message}`);
    sharedListId = (shared as { id: string }).id;

    // `owner_id` is what makes it personal. `department_id` is required even so
    // and then overwritten by `vizserve_pms_lists_owner_guard`, which derives it
    // from the owner — so it is sent already agreeing with the trigger.
    const { data: privateList, error: privateError } = await admin
      .from("vizserve_pms_lists")
      .insert({
        department_id: DEPARTMENTS.VizBytes,
        name: `P12-16 private ${Math.random().toString(36).slice(2, 8)}`,
        owner_id: member1.userId,
      } as never)
      .select("id")
      .single();

    if (privateError) throw new Error(`fixture private list: ${privateError.message}`);
    privateListId = (privateList as { id: string }).id;

    for (const [listId, label] of [
      [sharedListId, "shared"],
      [privateListId, "private"],
    ] as const) {
      const { data, error } = await member1.client.rpc("vizserve_pms_create_personal_task", {
        p_title: `P12-16 ${label} ${Math.random().toString(36).slice(2, 8)}`,
        p_description: "Recorded by its assignee, which is all is_personal means.",
        p_due_date: null,
        p_list_id: listId,
      });

      if (error) throw new Error(`fixture ${label} task: ${error.message}`);
      if (label === "shared") sharedListTaskId = (data as { task_id: string }).task_id;
      else privateListTaskId = (data as { task_id: string }).task_id;
    }
  });

  afterAll(async () => {
    if (!run) return;

    const admin = adminClient();
    const taskIds = [sharedListTaskId, privateListTaskId].filter(Boolean);

    // Tasks first: a list with rows still pointing at it cannot go.
    if (taskIds.length > 0) {
      await admin.from("vizserve_pms_notifications").delete().in("entity_id", taskIds);
      await admin.from("vizserve_pms_tasks").delete().in("id", taskIds);
    }

    const listIds = [sharedListId, privateListId].filter(Boolean);
    if (listIds.length > 0) await admin.from("vizserve_pms_lists").delete().in("id", listIds);
  });

  it("shows a peer a colleague's is_personal task filed in a SHARED list", async () => {
    /*
     * THE BUG THIS MIGRATION WAS WRITTEN FOR, as a count. Four ONGOING tickets
     * sat in "User Support" under VizBytes — printers, logins, file access — and
     * the support team read zero of them, because every one had been typed by
     * its own assignee and `quickAddTask` sets `is_personal` on exactly that.
     */
    const { client } = await signIn("member2VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", sharedListTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("still hides a colleague's task filed in their PERSONAL list", async () => {
    /*
     * THE HALF THAT MUST NOT MOVE, and the one a "simplify the policies" pass
     * would take with it. P11-06 exists so somebody can say "this is mine
     * alone"; if this case ever passes with a row, that sentence has stopped
     * being true and the lead's clause is the only thing left saying it.
     */
    const { client } = await signIn("member2VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", privateListTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("leaves a LIST-LESS personal task invisible to a peer", async () => {
    /*
     * The asymmetry with the lead's clause, asserted so it is a decision rather
     * than a gap somebody closes for symmetry later. Filing work into a shared
     * list is the act that shares it; a task in no list has not been filed
     * anywhere, so P7-17's original test still answers for it.
     *
     * `personalTaskId` is the P7-17 fixture — created with `p_list_id: null` —
     * and the case above it in this file asserts the same thing from the other
     * migration's side. Both are kept: they will diverge the day somebody
     * mirrors the lead's clause here.
     */
    const { client } = await signIn("member2VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .eq("id", personalTaskId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("still shows both tasks to their owner", async () => {
    // The first disjunct in the policy, and the reason no clause below it can
    // lock somebody out of their own list. Asserted because this migration
    // rewrote the clause immediately after it.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_tasks")
      .select("id")
      .in("id", [sharedListTaskId, privateListTaskId]);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });
});
